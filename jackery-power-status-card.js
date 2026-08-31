/**
 * Jackery Power Status Card - Single-glance card combining solar input
 * status with grid/battery input status, instead of several disconnected
 * native HA tiles.
 *
 * Auto-discovers a Smart Transfer Switch device (for grid/battery/mode
 * status) and a solar-capable portable device (for solar input/status).
 * Either half can be configured explicitly and either half degrades
 * gracefully if its device isn't present.
 */

class JackeryPowerStatusCard extends HTMLElement {
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

  static getStubConfig() {
    return {};
  }

  // -- Lock persistence ----------------------------------------------------

  async _loadLock() {
    if (!this._hass) return;
    try {
      const result = await this._hass.callWS({ type: "frontend/get_user_data", key: "jackery_power_status_locked" });
      this._locked = (result && result.value !== undefined && result.value !== null) ? !!result.value : true;
      this._render();
    } catch { /* default locked */ }
  }

  _toggleLock() {
    this._locked = !this._locked;
    if (this._hass) {
      this._hass.callWS({ type: "frontend/set_user_data", key: "jackery_power_status_locked", value: this._locked }).catch(() => {});
    }
    this._render();
  }

  // -- Switch control --------------------------------------------------------

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
      console.error("[jackery-power-status-card] toggle error", e);
    }
  }

  // -- Entity discovery -------------------------------------------------

  _findEntity(suffix, domain) {
    if (!this._hass) return null;
    const prefix = `${domain}.`;
    const match = Object.keys(this._hass.states).find(
      (k) => k.startsWith(prefix) && k.endsWith(suffix)
    );
    return match || null;
  }

  _getSwitchPrefix() {
    if (this._config.switch_device_prefix) return this._config.switch_device_prefix;
    const match = this._findEntity("_power_system_state", "sensor");
    return match ? match.slice("sensor.".length, -"_power_system_state".length) : null;
  }

  _getSolarPrefix() {
    if (this._config.solar_device_prefix) return this._config.solar_device_prefix;
    const match = this._findEntity("_ac_power_solar_panel", "sensor");
    return match ? match.slice("sensor.".length, -"_ac_power_solar_panel".length) : null;
  }

  // -- State helpers ------------------------------------------------------

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

  // Collect every entity id this render pass cares about, and only re-render
  // when one of those states actually changed (keeps updates cheap).
  _watchedEntityIds() {
    const switchPrefix = this._getSwitchPrefix();
    const solarPrefix = this._getSolarPrefix();
    const gbPrefix = switchPrefix || solarPrefix;
    const ids = [
      this._findEntity("_ac_power_solar_panel", "sensor"),
      this._findEntity("_solar_status", "sensor"),
      this._findEntity("_parallel_connection", "sensor"),
      this._config.solar_efficiency_entity || null,
    ];
    if (gbPrefix) {
      ids.push(`sensor.${gbPrefix}_total_input_power`, `sensor.${gbPrefix}_output_power`, `sensor.${gbPrefix}_remaining_battery`);
      if (switchPrefix) {
        ids.push(
          `sensor.${gbPrefix}_power_system_state`,
          `switch.${gbPrefix}_grid_station`,
          `select.${gbPrefix}_working_mode`,
          `switch.${gbPrefix}_ups_mode`,
          `switch.${gbPrefix}_force_charge`,
          `number.${gbPrefix}_backup_reserve`,
          `sensor.${gbPrefix}_ac1_battery_status`,
          `sensor.${gbPrefix}_ac2_battery_status`,
          `sensor.${gbPrefix}_mains_power_fault`
        );
      } else {
        ids.push(`sensor.${gbPrefix}_battery_status`);
      }
    }
    return ids.filter(Boolean);
  }

  _watchedStatesChanged(prev, curr) {
    return this._watchedEntityIds().some((id) => prev.states[id] !== curr.states[id]);
  }

  // -- Presentation helpers -------------------------------------------------

  _batteryIcon(pct, charging) {
    if (pct === null) return "mdi:battery-unknown";
    if (charging) return pct >= 100 ? "mdi:battery-charging-100" : `mdi:battery-charging-${Math.max(10, Math.round(pct / 10) * 10)}`;
    if (pct <= 5) return "mdi:battery-outline";
    if (pct >= 95) return "mdi:battery";
    return `mdi:battery-${Math.round(pct / 10) * 10}`;
  }

  _batteryStatusColor(status) {
    switch (status) {
      case "Charging": return "#4CAF50";
      case "Discharging": return "#FF9800";
      case "Fault": return "#f44336";
      default: return "var(--secondary-text-color)";
    }
  }

  _pssIcon(pss) {
    return pss === "Station Power" ? "mdi:battery-charging-high" : "mdi:transmission-tower";
  }

  _pssColor(pss) {
    return pss === "Station Power" ? "#4CAF50" : "var(--info-color, #2196F3)";
  }

  _fmtWatts(w) {
    return w === null ? "\u2014" : `${Math.round(w)} W`;
  }

  // -- Render -------------------------------------------------------------

  _render() {
    if (!this.shadowRoot) return;
    this._hasRendered = true;

    const title = this._config.title || "Power Status";
    const switchPrefix = this._getSwitchPrefix();
    const solarPrefix = this._getSolarPrefix();

    if (!switchPrefix && !solarPrefix) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          <div style="padding: 16px; text-align: center; color: var(--secondary-text-color);">
            No Jackery solar or Transfer Switch entities found
          </div>
        </ha-card>
      `;
      return;
    }

    // Solar half
    const solarPowerEntity = solarPrefix ? `sensor.${solarPrefix}_ac_power_solar_panel` : null;
    const solarPower = this._num(solarPowerEntity);
    const solarType = this._text(this._findEntity("_solar_status", "sensor"));
    const parallel = this._text(this._findEntity("_parallel_connection", "sensor"));
    const solarActive = solarPower !== null && solarPower > 0;
    // Optional: requires a user-configured template helper (e.g. built from a Tempest weather station), not auto-discovered
    const solarEfficiency = this._config.solar_efficiency_entity ? this._num(this._config.solar_efficiency_entity) : null;

    // Grid/battery half: prefer the Transfer Switch, fall back to the solar device itself
    const gbPrefix = switchPrefix || solarPrefix;
    const isSwitch = !!switchPrefix;
    const inputPower = this._num(`sensor.${gbPrefix}_total_input_power`);
    const outputPower = this._num(`sensor.${gbPrefix}_output_power`);
    const battery = this._num(`sensor.${gbPrefix}_remaining_battery`);
    const pss = isSwitch ? this._text(`sensor.${gbPrefix}_power_system_state`) : null;
    const gridStationEntity = isSwitch ? `switch.${gbPrefix}_grid_station` : null;
    const stationOn = isSwitch ? this._effectiveOn(gridStationEntity, this._isOn(gridStationEntity)) : false;
    const mode = isSwitch ? this._text(`select.${gbPrefix}_working_mode`) : null;
    const upsEntity = isSwitch ? `switch.${gbPrefix}_ups_mode` : null;
    const upsOn = isSwitch ? this._effectiveOn(upsEntity, this._isOn(upsEntity)) : false;
    const forceChargeEntity = isSwitch ? `switch.${gbPrefix}_force_charge` : null;
    const forceChargeOn = isSwitch ? this._effectiveOn(forceChargeEntity, this._isOn(forceChargeEntity)) : false;
    const reserve = isSwitch ? this._num(`number.${gbPrefix}_backup_reserve`) : null;
    const batteryStatus = isSwitch
      ? this._text(`sensor.${gbPrefix}_ac1_battery_status`) ?? this._text(`sensor.${gbPrefix}_ac2_battery_status`)
      : this._text(`sensor.${gbPrefix}_battery_status`);
    const mainsFault = isSwitch ? this._text(`sensor.${gbPrefix}_mains_power_fault`) : null;
    const charging = batteryStatus === "Charging";
    // The badge reflects the pending optimistic toggle, not just the last-known sensor text
    const pssDisplay = isSwitch ? (stationOn ? "Station Power" : "Grid Power") : pss;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; box-sizing: border-box; font-family: var(--primary-font-family, Roboto, sans-serif); }
        ha-card { width: 100%; padding: 16px; box-sizing: border-box; container-type: inline-size; }
        .header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        .header h2 { margin: 0; flex: 1; font-size: 1.1em; font-weight: 500; color: var(--primary-text-color); }
        .lock-btn {
          background: none;
          border: none;
          cursor: pointer;
          padding: 4px 8px;
          border-radius: 8px;
          color: var(--secondary-text-color);
          line-height: 1;
          display: flex;
          align-items: center;
          --mdc-icon-size: 20px;
        }
        .lock-btn:hover { background: var(--divider-color, #e0e0e0); }
        .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @container (max-width: 420px) {
          .columns { grid-template-columns: 1fr; }
        }
        @container (min-width: 700px) {
          .columns { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); }
        }
        .panel {
          border-radius: 12px;
          border: 1px solid var(--divider-color, #e0e0e0);
          background: var(--card-background-color, var(--secondary-background-color));
          padding: 12px;
          container-type: inline-size;
        }
        .panel-title {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.8em;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--secondary-text-color);
          margin-bottom: 8px;
        }
        .panel-title ha-icon { --mdc-icon-size: 16px; }
        .big-value {
          display: flex;
          align-items: baseline;
          gap: 6px;
          margin-bottom: 6px;
        }
        .big-value .num { font-size: 1.8em; font-weight: 600; color: var(--primary-text-color); line-height: 1; }
        .big-value .unit { font-size: 0.9em; color: var(--secondary-text-color); }
        .metric-row {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 6px;
        }
        .metric-power {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .power-line {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.85em;
          color: var(--secondary-text-color);
        }
        .power-line ha-icon { --mdc-icon-size: 16px; }
        @container (min-width: 260px) {
          .metric-row { flex-direction: row; align-items: center; gap: 20px; }
          .metric-row .big-value { margin-bottom: 0; }
          .metric-power { border-left: 1px solid var(--divider-color, #e0e0e0); padding-left: 16px; }
        }
        .sub-row {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.85em;
          color: var(--secondary-text-color);
          margin-top: 4px;
        }
        .sub-row ha-icon { --mdc-icon-size: 16px; }
        .status-line {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          margin-top: 4px;
        }
        .status-line .status-badge, .status-line .sub-row { margin-top: 0; }
        .status-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 0.8em;
          font-weight: 500;
          margin-top: 4px;
          border: none;
          font-family: inherit;
        }
        .status-badge ha-icon { --mdc-icon-size: 14px; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
        .chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 8px;
          border-radius: 10px;
          font-size: 0.75em;
          font-weight: 500;
          background: var(--divider-color, #e0e0e0);
          color: var(--secondary-text-color);
          border: none;
          font-family: inherit;
        }
        .chip.active { background: rgba(76, 175, 80, 0.18); color: #4CAF50; }
        .chip.warn { background: rgba(244, 67, 54, 0.18); color: #f44336; }
        .chip ha-icon { --mdc-icon-size: 14px; }
        .toggle:not(:disabled) { cursor: pointer; }
        .toggle:not(:disabled):hover { filter: brightness(0.92); }
        .toggle:disabled { opacity: 0.7; }
        .fault-banner {
          margin-top: 12px;
          padding: 6px 10px;
          border-radius: 8px;
          background: rgba(244, 67, 54, 0.12);
          color: #f44336;
          font-size: 0.8em;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .fault-banner ha-icon { --mdc-icon-size: 16px; }
      </style>
      <ha-card>
        <div class="header">
          <h2>${title}</h2>
          <button class="lock-btn" id="lock-btn" title="${this._locked ? 'Unlock controls' : 'Lock controls'}"><ha-icon icon="${this._locked ? 'mdi:lock' : 'mdi:lock-open-variant'}"></ha-icon></button>
        </div>
        <div class="columns">
          <div class="panel">
            <div class="panel-title">
              <ha-icon icon="mdi:solar-power" style="color: ${solarActive ? "#FFC107" : "var(--secondary-text-color)"}"></ha-icon>
              Solar
            </div>
            ${solarPrefix
              ? `
                <div class="metric-row">
                  <div class="big-value">
                    <span class="num">${solarPower !== null ? Math.round(solarPower) : "\u2014"}</span>
                    <span class="unit">W</span>
                  </div>
                  ${solarType || (parallel && parallel !== "None") ? `
                    <div class="metric-power">
                      ${solarType ? `<div class="power-line"><ha-icon icon="mdi:solar-power-variant"></ha-icon>${solarType}</div>` : ""}
                      ${parallel && parallel !== "None" ? `<div class="power-line"><ha-icon icon="mdi:battery-sync"></ha-icon>${parallel}</div>` : ""}
                    </div>
                  ` : ""}
                  ${solarEfficiency !== null ? `
                    <div class="metric-power">
                      <div class="power-line"><ha-icon icon="mdi:gauge"></ha-icon>${Math.round(solarEfficiency)}% Efficiency</div>
                    </div>
                  ` : ""}
                </div>
              `
              : `<div class="sub-row">No solar-capable device found</div>`
            }
          </div>
          <div class="panel">
            <div class="panel-title">
              <ha-icon icon="${this._pssIcon(pssDisplay)}" style="color: ${gbPrefix ? this._pssColor(pssDisplay) : "var(--secondary-text-color)"}"></ha-icon>
              ${isSwitch ? "Grid &amp; Battery" : "Battery"}
            </div>
            ${gbPrefix
              ? `
                <div class="metric-row">
                  <div class="big-value">
                    <ha-icon icon="${this._batteryIcon(battery, charging)}" style="color: ${this._batteryStatusColor(batteryStatus)}"></ha-icon>
                    <span class="num">${battery !== null ? Math.round(battery) : "\u2014"}</span>
                    <span class="unit">%</span>
                  </div>
                  <div class="metric-power">
                    <div class="power-line"><ha-icon icon="mdi:battery-arrow-up"></ha-icon>In ${this._fmtWatts(inputPower)}</div>
                    <div class="power-line"><ha-icon icon="mdi:battery-arrow-down"></ha-icon>Out ${this._fmtWatts(outputPower)}</div>
                  </div>
                </div>
                <div class="status-line">
                  ${pssDisplay ? `
                    <button class="status-badge toggle" data-switch="${gridStationEntity}" ${this._locked ? "disabled" : ""} title="${this._locked ? "Unlock to switch Grid/Station" : "Tap to switch Grid/Station"}" style="background: ${pssDisplay === "Station Power" ? "rgba(76,175,80,0.15)" : "rgba(33,150,243,0.15)"}; color: ${this._pssColor(pssDisplay)}">
                      <ha-icon icon="${this._pssIcon(pssDisplay)}"></ha-icon>${pssDisplay}
                    </button>
                  ` : ""}
                  ${mode ? `<div class="sub-row"><ha-icon icon="mdi:cog-outline"></ha-icon>${mode}</div>` : ""}
                </div>
                <div class="chips">
                  ${reserve !== null ? `<span class="chip"><ha-icon icon="mdi:battery-lock"></ha-icon>Reserve ${Math.round(reserve)}%</span>` : ""}
                  ${isSwitch ? `<button class="chip toggle ${upsOn ? "active" : ""}" data-switch="${upsEntity}" ${this._locked ? "disabled" : ""} title="${this._locked ? "Unlock to control" : "Tap to toggle"}"><ha-icon icon="mdi:flash-triangle-outline"></ha-icon>UPS ${upsOn ? "On" : "Off"}</button>` : ""}
                  ${isSwitch ? `<button class="chip toggle ${forceChargeOn ? "active" : ""}" data-switch="${forceChargeEntity}" ${this._locked ? "disabled" : ""} title="${this._locked ? "Unlock to control" : "Tap to toggle"}"><ha-icon icon="mdi:battery-charging-high"></ha-icon>Force Charge ${forceChargeOn ? "On" : "Off"}</button>` : ""}
                </div>
                ${mainsFault && mainsFault !== "OK" ? `
                  <div class="fault-banner"><ha-icon icon="mdi:alert-circle"></ha-icon>${mainsFault}</div>
                ` : ""}
              `
              : `<div class="sub-row">No Transfer Switch or battery device found</div>`
            }
          </div>
        </div>
      </ha-card>
    `;

    this.shadowRoot.getElementById("lock-btn")?.addEventListener("click", () => {
      this._toggleLock();
    });
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

customElements.define("jackery-power-status-card", JackeryPowerStatusCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "jackery-power-status-card",
  name: "Jackery Power Status",
  description: "Single-glance card combining solar input status with grid/battery input status",
});
