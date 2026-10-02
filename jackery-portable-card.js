/**
 * Jackery Portable Card - Single-glance status + output control for a Jackery
 * portable power station (Explorer series), the portable counterpart to the
 * Power Status card used for the Smart Transfer Switch.
 *
 * Resolves its device from the HA device registry (Jackery-platform entities
 * grouped by device, Transfer Switches excluded) rather than entity-id naming,
 * so renamed entities and "_2" id suffixes still resolve. Override with
 * `device` (device name or id), or `device_prefix` for a raw entity-id prefix.
 */

class JackeryPortableCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._hasRendered = false;
    this._locked = true;
    this._optimisticToggles = new Map(); // entityId -> {isOn, expiry}
  }

  setConfig(config) {
    this._config = config || {};
    this._hasRendered = false;
    this._idCache = null;
    if (this._hass) this._render();
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!prev && hass) {
      this._loadLock();
      this._render();
    } else if (!this._hasRendered || this._watchedStatesChanged(prev, hass)) {
      this._render();
    }
  }

  static getStubConfig(hass) {
    const device = JackeryPortableCard._portableDevices(hass)[0];
    return device ? { device: device.name } : {};
  }

  // -- Lock persistence ----------------------------------------------------

  async _loadLock() {
    if (!this._hass) return;
    try {
      const result = await this._hass.callWS({ type: "frontend/get_user_data", key: "jackery_portable_locked" });
      this._locked = (result && result.value !== undefined && result.value !== null) ? !!result.value : true;
      this._render();
    } catch { /* default locked */ }
  }

  _toggleLock() {
    this._locked = !this._locked;
    if (this._hass) {
      this._hass.callWS({ type: "frontend/set_user_data", key: "jackery_portable_locked", value: this._locked }).catch(() => {});
    }
    this._render();
  }

  // -- Switch control ------------------------------------------------------

  _effectiveOn(entityId, actualOn) {
    const toggle = this._optimisticToggles.get(entityId);
    if (!toggle) return actualOn;
    if (Date.now() > toggle.expiry || toggle.isOn === actualOn) {
      this._optimisticToggles.delete(entityId);
      return actualOn;
    }
    return toggle.isOn;
  }

  async _toggleSwitch(entityId) {
    if (!this._hass || !entityId || this._locked) return;
    const state = this._hass.states[entityId];
    if (!state) return;
    const newOn = state.state !== "on";
    this._optimisticToggles.set(entityId, { isOn: newOn, expiry: Date.now() + 15000 });
    this._render();
    try {
      await this._hass.callService("switch", newOn ? "turn_on" : "turn_off", { entity_id: entityId });
      setTimeout(() => this._render(), 1500);
      setTimeout(() => this._render(), 4000);
    } catch (e) {
      this._optimisticToggles.delete(entityId);
      this._render();
      console.error("[jackery-portable-card] toggle error", e);
    }
  }

  // -- Device / entity discovery -------------------------------------------

  // Devices are resolved from the registry rather than entity-id naming, which
  // breaks as soon as an entity is renamed or HA appends a "_2" suffix.
  static _jackeryDevices(hass) {
    if (!hass?.entities || !hass?.devices) return [];
    const byDevice = new Map();
    for (const entry of Object.values(hass.entities)) {
      if (entry?.platform !== "jackery" || !entry.device_id) continue;
      if (!byDevice.has(entry.device_id)) byDevice.set(entry.device_id, []);
      byDevice.get(entry.device_id).push(entry.entity_id);
    }
    return [...byDevice.entries()]
      .map(([deviceId, entityIds]) => {
        const device = hass.devices[deviceId];
        return {
          deviceId,
          name: device?.name_by_user || device?.name || deviceId,
          entityIds,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  static _portableDevices(hass) {
    return JackeryPortableCard._jackeryDevices(hass).filter(
      (d) => !d.entityIds.some((id) => id.endsWith("_power_system_state"))
    );
  }

  _resolveDevice() {
    const wanted = this._config.device;
    if (wanted) {
      const needle = String(wanted).toLowerCase();
      return (
        JackeryPortableCard._jackeryDevices(this._hass).find(
          (d) => d.deviceId === wanted || d.name.toLowerCase() === needle
        ) || null
      );
    }
    return JackeryPortableCard._portableDevices(this._hass)[0] || null;
  }

  // Entity ids to search: an explicit device_prefix wins over registry lookup.
  _candidateEntityIds() {
    const entities = this._hass?.entities;
    const devices = this._hass?.devices;
    if (this._idCache && this._idCache.entities === entities && this._idCache.devices === devices) {
      return this._idCache.ids;
    }
    let ids;
    if (this._config.device_prefix) {
      const marker = `.${this._config.device_prefix}_`;
      ids = Object.keys(this._hass?.states || {}).filter((id) => id.includes(marker));
    } else {
      ids = this._resolveDevice()?.entityIds || [];
    }
    this._idCache = { entities, devices, ids };
    return ids;
  }

  _entity(domain, suffix) {
    if (!this._hass) return null;
    const tail = `_${suffix}`;
    // Shortest match wins so e.g. "_output_power" doesn't resolve to "_ac_output_power".
    let best = null;
    for (const id of this._candidateEntityIds()) {
      if (!id.startsWith(`${domain}.`) || !this._hass.states[id]) continue;
      if (!id.endsWith(tail) && !id.endsWith(`${tail}_2`)) continue;
      if (best === null || id.length < best.length) best = id;
    }
    return best;
  }

  // -- State helpers -------------------------------------------------------

  _state(entityId) {
    if (!entityId) return null;
    const s = this._hass?.states[entityId];
    if (!s || s.state === "unavailable" || s.state === "unknown") return null;
    return s;
  }

  _num(entityId) {
    const s = this._state(entityId);
    if (!s) return null;
    const n = parseFloat(s.state);
    return isNaN(n) ? null : n;
  }

  _text(entityId) {
    return this._state(entityId)?.state ?? null;
  }

  _isOn(entityId) {
    return this._state(entityId)?.state === "on";
  }

  _outputSwitches() {
    return [
      { id: this._entity("switch", "ac_output"), label: "AC", icon: "mdi:power-plug" },
      { id: this._entity("switch", "dc_output"), label: "DC", icon: "mdi:power" },
      { id: this._entity("switch", "usb_output"), label: "USB", icon: "mdi:usb-port" },
      { id: this._entity("switch", "dc_car_output"), label: "Car", icon: "mdi:car" },
      { id: this._entity("switch", "super_fast_charge"), label: "Fast Charge", icon: "mdi:flash" },
    ].filter((s) => s.id);
  }

  _portPowers() {
    return [
      { id: this._entity("sensor", "ac_output_power"), label: "AC", icon: "mdi:power-plug" },
      { id: this._entity("sensor", "usb_a_port_1_power"), label: "USB-A 1", icon: "mdi:usb" },
      { id: this._entity("sensor", "usb_a_port_2_power"), label: "USB-A 2", icon: "mdi:usb" },
      { id: this._entity("sensor", "usb_a_port_3_power"), label: "USB-A 3", icon: "mdi:usb" },
      { id: this._entity("sensor", "usb_c_port_1_power"), label: "USB-C 1", icon: "mdi:usb-c-port" },
      { id: this._entity("sensor", "usb_c_port_2_power"), label: "USB-C 2", icon: "mdi:usb-c-port" },
      { id: this._entity("sensor", "usb_c_port_3_power"), label: "USB-C 3", icon: "mdi:usb-c-port" },
      { id: this._entity("sensor", "car_12v_output_power"), label: "Car 12V", icon: "mdi:car" },
    ].filter((p) => p.id);
  }

  _watchedEntityIds() {
    const ids = [
      this._entity("sensor", "remaining_battery"),
      this._entity("sensor", "battery_status"),
      this._entity("sensor", "output_power"),
      this._entity("sensor", "total_input_power"),
      this._entity("sensor", "ac_input_power"),
      this._entity("sensor", "dc_input_power"),
      this._entity("sensor", "ac_power_solar_panel"),
      this._entity("sensor", "remaining_output_time"),
      this._entity("sensor", "time_to_full"),
      this._entity("sensor", "battery_temperature"),
      this._entity("sensor", "ac_output_voltage"),
      this._entity("sensor", "ac_output_frequency"),
      this._entity("sensor", "error_code"),
      this._entity("sensor", "solar_type"),
      this._entity("sensor", "parallel_connection"),
      this._entity("select", "light_mode"),
      this._entity("select", "charge_speed"),
      this._entity("select", "battery_protection"),
      this._entity("binary_sensor", "temperature_alarm"),
      this._entity("binary_sensor", "power_alarm"),
      this._entity("binary_sensor", "transfer_switch_connected"),
      this._entity("binary_sensor", "ac_pass_through"),
      this._entity("binary_sensor", "output_active"),
    ];
    this._outputSwitches().forEach((s) => ids.push(s.id));
    this._portPowers().forEach((p) => ids.push(p.id));
    return ids.filter(Boolean);
  }

  _watchedStatesChanged(prev, curr) {
    return this._watchedEntityIds().some((id) => prev.states[id] !== curr.states[id]);
  }

  // -- Presentation helpers ------------------------------------------------

  _batteryIcon(pct, charging) {
    if (pct === null) return "mdi:battery-unknown";
    if (charging) return pct >= 100 ? "mdi:battery-charging-100" : `mdi:battery-charging-${Math.max(10, Math.round(pct / 10) * 10)}`;
    if (pct <= 5) return "mdi:battery-outline";
    if (pct >= 95) return "mdi:battery";
    return `mdi:battery-${Math.round(pct / 10) * 10}`;
  }

  _batteryColor(pct, status) {
    if (status === "Fault") return "#f44336";
    if (status === "Charging") return "#4CAF50";
    if (pct !== null && pct <= 15) return "#f44336";
    if (pct !== null && pct <= 30) return "#FF9800";
    return "var(--primary-text-color)";
  }

  _fmtWatts(w) {
    return w === null ? "--" : `${Math.round(w)} W`;
  }

  // Runtime sensors report fractional hours.
  _fmtHours(h) {
    if (h === null || h <= 0) return null;
    const total = Math.round(h * 60);
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return hours ? `${hours}h ${mins}m` : `${mins}m`;
  }

  _deviceName() {
    const device = this._config.device_prefix ? null : this._resolveDevice();
    if (device) return device.name;
    const anchor = this._entity("sensor", "remaining_battery") || this._entity("switch", "ac_output");
    const friendly = anchor ? this._hass.states[anchor]?.attributes?.friendly_name : null;
    // Strip the trailing entity name to leave just the device name.
    if (friendly) return friendly.replace(/\s+(Remaining Battery|AC Output)$/i, "");
    return (this._config.device_prefix || "").replace(/_/g, " ");
  }

  // -- Render --------------------------------------------------------------

  _render() {
    if (!this.shadowRoot) return;
    this._hasRendered = true;

    const hasEntities = this._candidateEntityIds().length > 0;
    if (!hasEntities) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          <div style="padding: 16px; text-align: center; color: var(--secondary-text-color);">
            ${this._config.device || this._config.device_prefix
              ? `No entities found for "${this._config.device || this._config.device_prefix}"`
              : "No Jackery portable power station entities found"}
          </div>
        </ha-card>
      `;
      return;
    }

    const title = this._config.title || this._deviceName();
    const battery = this._num(this._entity("sensor", "remaining_battery"));
    const status = this._text(this._entity("sensor", "battery_status"));
    const charging = status === "Charging";
    const inputPower = this._num(this._entity("sensor", "total_input_power"));
    const outputPower = this._num(this._entity("sensor", "output_power"));
    const acIn = this._num(this._entity("sensor", "ac_input_power"));
    const dcIn = this._num(this._entity("sensor", "dc_input_power"));
    const solarIn = this._num(this._entity("sensor", "ac_power_solar_panel"));
    const runtime = this._fmtHours(this._num(this._entity("sensor", "remaining_output_time")));
    const timeToFull = this._fmtHours(this._num(this._entity("sensor", "time_to_full")));
    const temp = this._num(this._entity("sensor", "battery_temperature"));
    const volts = this._num(this._entity("sensor", "ac_output_voltage"));
    const hz = this._num(this._entity("sensor", "ac_output_frequency"));
    const solarType = this._text(this._entity("sensor", "solar_type"));
    const parallel = this._text(this._entity("sensor", "parallel_connection"));
    const lightMode = this._text(this._entity("select", "light_mode"));
    const chargeSpeed = this._text(this._entity("select", "charge_speed"));
    const protection = this._text(this._entity("select", "battery_protection"));
    const boxConnected = this._isOn(this._entity("binary_sensor", "transfer_switch_connected"));
    const passThrough = this._isOn(this._entity("binary_sensor", "ac_pass_through"));
    const tempAlarm = this._isOn(this._entity("binary_sensor", "temperature_alarm"));
    const powerAlarm = this._isOn(this._entity("binary_sensor", "power_alarm"));
    const errorCode = this._text(this._entity("sensor", "error_code"));
    const hasError = errorCode !== null && errorCode !== "0" && errorCode.toLowerCase() !== "none";

    const timeLine = charging
      ? (timeToFull ? `${timeToFull} to full` : null)
      : (runtime ? `${runtime} remaining` : null);

    const switches = this._outputSwitches();
    const ports = this._portPowers().map((p) => ({ ...p, watts: this._num(p.id) }));
    const activePorts = ports.filter((p) => p.watts !== null && p.watts > 0);

    const barColor = this._batteryColor(battery, status);
    const alarms = [];
    if (tempAlarm) alarms.push("Temperature alarm");
    if (powerAlarm) alarms.push("Power alarm");
    if (hasError) alarms.push(`Error code ${errorCode}`);

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; box-sizing: border-box; font-family: var(--primary-font-family, Roboto, sans-serif); }
        ha-card { width: 100%; padding: 16px; box-sizing: border-box; container-type: inline-size; }
        .header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        .header h2 { margin: 0; flex: 1; font-size: 1.1em; font-weight: 500; color: var(--primary-text-color); }
        .lock-btn {
          background: none; border: none; cursor: pointer; padding: 4px 8px; border-radius: 8px;
          color: var(--secondary-text-color); line-height: 1; display: flex; align-items: center;
          --mdc-icon-size: 20px;
        }
        .lock-btn:hover { background: var(--divider-color, #e0e0e0); }
        .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @container (max-width: 420px) { .columns { grid-template-columns: 1fr; } }
        .panel {
          border-radius: 12px; border: 1px solid var(--divider-color, #e0e0e0);
          background: var(--card-background-color, var(--secondary-background-color));
          padding: 12px; container-type: inline-size;
        }
        .panel-title {
          display: flex; align-items: center; gap: 6px; font-size: 0.8em; font-weight: 600;
          text-transform: uppercase; letter-spacing: 0.04em; color: var(--secondary-text-color);
          margin-bottom: 8px;
        }
        .panel-title ha-icon { --mdc-icon-size: 16px; }
        .big-value { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; }
        .big-value .num { font-size: 1.8em; font-weight: 600; line-height: 1; }
        .big-value .unit { font-size: 0.9em; color: var(--secondary-text-color); }
        .big-value ha-icon { --mdc-icon-size: 26px; align-self: center; }
        .metric-row { display: flex; flex-direction: column; gap: 8px; margin-bottom: 6px; }
        .metric-power { display: flex; flex-direction: column; gap: 2px; }
        .power-line {
          display: flex; align-items: center; gap: 6px; font-size: 0.85em;
          color: var(--secondary-text-color); white-space: nowrap;
        }
        .power-line ha-icon { --mdc-icon-size: 16px; }
        @container (min-width: 260px) {
          .metric-row { flex-direction: row; align-items: center; gap: 20px; }
          .metric-row .big-value { margin-bottom: 0; }
          .metric-power { border-left: 1px solid var(--divider-color, #e0e0e0); padding-left: 16px; }
        }
        .bar { height: 8px; border-radius: 4px; background: var(--divider-color, #e0e0e0); overflow: hidden; margin: 8px 0 6px; }
        .bar > div { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
        .sub-row {
          display: flex; align-items: center; gap: 6px; font-size: 0.85em;
          color: var(--secondary-text-color); margin-top: 4px;
        }
        .sub-row ha-icon { --mdc-icon-size: 16px; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
        .chip {
          display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 10px;
          font-size: 0.75em; font-weight: 500; background: var(--divider-color, #e0e0e0);
          color: var(--secondary-text-color); border: none; font-family: inherit;
        }
        .chip.active { background: rgba(76, 175, 80, 0.18); color: #4CAF50; }
        .chip ha-icon { --mdc-icon-size: 14px; }
        .toggle:not(:disabled) { cursor: pointer; }
        .toggle:not(:disabled):hover { filter: brightness(0.92); }
        .toggle:disabled { opacity: 0.7; }
        .fault-banner {
          margin-top: 12px; padding: 6px 10px; border-radius: 8px; background: rgba(244, 67, 54, 0.12);
          color: #f44336; font-size: 0.8em; display: flex; align-items: center; gap: 6px;
        }
        .fault-banner ha-icon { --mdc-icon-size: 16px; }
      </style>
      <ha-card>
        <div class="header">
          <h2>${title}</h2>
          <button class="lock-btn" id="lock-btn" title="${this._locked ? "Unlock controls" : "Lock controls"}"><ha-icon icon="${this._locked ? "mdi:lock" : "mdi:lock-open-variant"}"></ha-icon></button>
        </div>
        <div class="columns">
          <div class="panel">
            <div class="panel-title">
              <ha-icon icon="mdi:battery-high" style="color: ${barColor}"></ha-icon>
              Battery
            </div>
            <div class="metric-row">
              <div class="big-value" style="color: ${barColor}">
                <ha-icon icon="${this._batteryIcon(battery, charging)}"></ha-icon>
                <span class="num">${battery !== null ? Math.round(battery) : "--"}</span>
                <span class="unit">%</span>
              </div>
              <div class="metric-power">
                <div class="power-line"><ha-icon icon="mdi:battery-arrow-up"></ha-icon>In ${this._fmtWatts(inputPower)}</div>
                <div class="power-line"><ha-icon icon="mdi:battery-arrow-down"></ha-icon>Out ${this._fmtWatts(outputPower)}</div>
              </div>
            </div>
            <div class="bar"><div style="width: ${battery !== null ? Math.max(0, Math.min(100, battery)) : 0}%; background: ${barColor};"></div></div>
            <div class="sub-row">
              <ha-icon icon="${charging ? "mdi:battery-charging" : "mdi:battery-heart-variant"}"></ha-icon>${status || "Unknown"}${timeLine ? ` \u00b7 ${timeLine}` : ""}
            </div>
            ${temp !== null ? `<div class="sub-row"><ha-icon icon="mdi:thermometer"></ha-icon>${Math.round(temp)} \u00b0C</div>` : ""}
            <div class="chips">
              ${protection ? `<span class="chip"><ha-icon icon="mdi:battery-heart-variant"></ha-icon>${protection}</span>` : ""}
              ${chargeSpeed ? `<span class="chip"><ha-icon icon="mdi:battery-charging"></ha-icon>${chargeSpeed}</span>` : ""}
              ${lightMode && lightMode !== "off" ? `<span class="chip active"><ha-icon icon="mdi:lightbulb"></ha-icon>${lightMode}</span>` : ""}
              ${boxConnected ? `<span class="chip active"><ha-icon icon="mdi:transmission-tower"></ha-icon>Transfer Switch</span>` : ""}
              ${passThrough ? `<span class="chip active"><ha-icon icon="mdi:transit-connection-variant"></ha-icon>Pass-through</span>` : ""}
            </div>
          </div>
          <div class="panel">
            <div class="panel-title">
              <ha-icon icon="mdi:power-socket-us" style="color: ${outputPower ? "#FF9800" : "var(--secondary-text-color)"}"></ha-icon>
              Outputs &amp; Inputs
            </div>
            <div class="metric-power">
              ${acIn !== null ? `<div class="power-line"><ha-icon icon="mdi:power-plug"></ha-icon>AC In ${this._fmtWatts(acIn)}</div>` : ""}
              ${dcIn !== null ? `<div class="power-line"><ha-icon icon="mdi:current-dc"></ha-icon>DC In ${this._fmtWatts(dcIn)}</div>` : ""}
              ${solarIn !== null ? `<div class="power-line"><ha-icon icon="mdi:solar-power"></ha-icon>Solar In ${this._fmtWatts(solarIn)}${solarType ? ` \u00b7 ${solarType}` : ""}</div>` : ""}
              ${activePorts.map((p) => `<div class="power-line"><ha-icon icon="${p.icon}"></ha-icon>${p.label} ${this._fmtWatts(p.watts)}</div>`).join("")}
              ${volts !== null || hz !== null ? `<div class="power-line"><ha-icon icon="mdi:sine-wave"></ha-icon>${volts !== null ? `${Math.round(volts)} V` : ""}${volts !== null && hz !== null ? " \u00b7 " : ""}${hz !== null ? `${Math.round(hz)} Hz` : ""}</div>` : ""}
              ${parallel && parallel !== "None" ? `<div class="power-line"><ha-icon icon="mdi:battery-sync"></ha-icon>${parallel}</div>` : ""}
            </div>
            <div class="chips">
              ${switches.map((s) => {
                const on = this._effectiveOn(s.id, this._isOn(s.id));
                return `<button class="chip toggle ${on ? "active" : ""}" data-switch="${s.id}" ${this._locked ? "disabled" : ""} title="${this._locked ? "Unlock to control" : "Tap to toggle"}"><ha-icon icon="${s.icon}"></ha-icon>${s.label} ${on ? "On" : "Off"}</button>`;
              }).join("")}
            </div>
          </div>
        </div>
        ${alarms.length ? `<div class="fault-banner"><ha-icon icon="mdi:alert-circle"></ha-icon>${alarms.join(" \u00b7 ")}</div>` : ""}
      </ha-card>
    `;

    this.shadowRoot.getElementById("lock-btn")?.addEventListener("click", () => this._toggleLock());
    this.shadowRoot.querySelectorAll("button[data-switch]").forEach((btn) => {
      btn.addEventListener("click", () => this._toggleSwitch(btn.dataset.switch));
    });
  }

  getCardSize() {
    return 3;
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6 };
  }
}

if (!customElements.get("jackery-portable-card")) {
  customElements.define("jackery-portable-card", JackeryPortableCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "jackery-portable-card",
  name: "Jackery Portable Station",
  description: "Battery, input/output power, and output controls for a Jackery portable power station",
});
