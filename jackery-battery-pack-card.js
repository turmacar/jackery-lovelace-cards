/**
 * Jackery Battery Pack Status Card - Side-by-side AC1/AC2 slot display for
 * the Smart Transfer Switch: battery %, input/output power, time estimates,
 * charging status, and per-add-on-pack battery levels.
 *
 * Auto-discovers the Transfer Switch device via its AC1 battery-pack-count
 * sensor. Either slot degrades gracefully (shown as "Not Connected") if no
 * device is plugged into it.
 */

class JackeryBatteryPackCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._hasRendered = false;
  }

  setConfig(config) {
    this._config = config || {};
    this._hasRendered = false;
    if (this._hass) this._render();
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!this._hasRendered || this._watchedStatesChanged(prev, hass)) {
      this._render();
    }
  }

  static getStubConfig() {
    return {};
  }

  // -- Entity discovery -----------------------------------------------------

  _findEntity(suffix, domain) {
    if (!this._hass) return null;
    const prefix = `${domain}.`;
    const match = Object.keys(this._hass.states).find(
      (k) => k.startsWith(prefix) && k.endsWith(suffix)
    );
    return match || null;
  }

  _getDevicePrefix() {
    if (this._config.device_prefix) return this._config.device_prefix;
    const match = this._findEntity("_ac1_battery_packs", "sensor");
    return match ? match.slice("sensor.".length, -"_ac1_battery_packs".length) : null;
  }

  // -- State helpers ----------------------------------------------------------

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

  _watchedEntityIds() {
    const prefix = this._getDevicePrefix();
    if (!prefix) return [];
    const ids = [];
    for (const slot of ["ac1", "ac2"]) {
      ids.push(
        `sensor.${prefix}_${slot}_connected`,
        `sensor.${prefix}_${slot}_battery_level`,
        `sensor.${prefix}_${slot}_battery_status`,
        `sensor.${prefix}_${slot}_input_power`,
        `sensor.${prefix}_${slot}_output_power`,
        `sensor.${prefix}_${slot}_solar_input_power`,
        `sensor.${prefix}_${slot}_remaining_time`,
        `sensor.${prefix}_${slot}_time_to_full`,
        `sensor.${prefix}_${slot}_battery_packs`
      );
      for (let i = 1; i <= 5; i++) {
        ids.push(`sensor.${prefix}_${slot}_pack_${i}_battery`);
      }
    }
    return ids;
  }

  _watchedStatesChanged(prev, curr) {
    if (!prev) return true;
    return this._watchedEntityIds().some((id) => prev.states[id] !== curr.states[id]);
  }

  // -- Presentation helpers ---------------------------------------------------

  _batteryIcon(pct, charging) {
    if (pct === null) return "mdi:battery-unknown";
    if (charging) return pct >= 100 ? "mdi:battery-charging-100" : `mdi:battery-charging-${Math.max(10, Math.round(pct / 10) * 10)}`;
    if (pct <= 5) return "mdi:battery-outline";
    if (pct >= 95) return "mdi:battery";
    return `mdi:battery-${Math.round(pct / 10) * 10}`;
  }

  _statusColor(status) {
    switch (status) {
      case "Charging": return "#4CAF50";
      case "Discharging": return "#FF9800";
      case "Fault": return "#f44336";
      default: return "var(--secondary-text-color)";
    }
  }

  _fmtWatts(w) {
    return w === null ? "\u2014" : `${Math.round(w)} W`;
  }

  _fmtHours(h) {
    if (h === null) return null;
    if (h < 1) return `${Math.round(h * 60)}m`;
    return `${h.toFixed(1)}h`;
  }

  // -- Slot rendering -----------------------------------------------------

  _renderSlot(prefix, slot) {
    const label = slot.toUpperCase();
    const connected = this._text(`sensor.${prefix}_${slot}_connected`) === "Yes";

    if (!connected) {
      return `
        <div class="panel">
          <div class="panel-title">
            <ha-icon icon="mdi:battery-off-outline"></ha-icon>
            ${label}
          </div>
          <div class="empty-state">Not Connected</div>
        </div>
      `;
    }

    const battery = this._num(`sensor.${prefix}_${slot}_battery_level`);
    const status = this._text(`sensor.${prefix}_${slot}_battery_status`);
    const inputPower = this._num(`sensor.${prefix}_${slot}_input_power`);
    const outputPower = this._num(`sensor.${prefix}_${slot}_output_power`);
    const solarPower = this._num(`sensor.${prefix}_${slot}_solar_input_power`);
    const remaining = this._fmtHours(this._num(`sensor.${prefix}_${slot}_remaining_time`));
    const timeToFull = this._fmtHours(this._num(`sensor.${prefix}_${slot}_time_to_full`));
    const packCount = this._num(`sensor.${prefix}_${slot}_battery_packs`);
    const charging = status === "Charging";

    const packs = [];
    for (let i = 1; i <= 5; i++) {
      const packEntity = `sensor.${prefix}_${slot}_pack_${i}_battery`;
      const packLevel = this._num(packEntity);
      if (packLevel === null) continue;
      const sn = this._state(packEntity)?.attributes?.serial_number;
      packs.push({ num: i, level: packLevel, sn });
    }

    return `
      <div class="panel">
        <div class="panel-title">
          <ha-icon icon="${this._batteryIcon(battery, charging)}" style="color: ${this._statusColor(status)}"></ha-icon>
          ${label}
        </div>
        <div class="metric-row">
          <div class="big-value">
            <span class="num">${battery !== null ? Math.round(battery) : "\u2014"}</span>
            <span class="unit">%</span>
          </div>
          <div class="metric-power">
            <div class="power-line"><ha-icon icon="mdi:battery-arrow-up"></ha-icon>Charging from Grid: ${this._fmtWatts(inputPower)}</div>
            <div class="power-line"><ha-icon icon="mdi:battery-arrow-down"></ha-icon>Discharging to House: ${this._fmtWatts(outputPower)}</div>
            ${solarPower !== null ? `<div class="power-line"><ha-icon icon="mdi:solar-power" style="color: ${solarPower > 0 ? "#FFC107" : "var(--secondary-text-color)"}"></ha-icon>Charging from Solar: ${this._fmtWatts(solarPower)}</div>` : ""}
          </div>
        </div>
        <div class="status-line">
          ${status ? `<div class="sub-row"><ha-icon icon="mdi:battery-heart-variant" style="color: ${this._statusColor(status)}"></ha-icon>${status}${solarPower > 0 && status === "Discharging" ? " (grid)" : ""}</div>` : ""}
          ${charging && timeToFull ? `<div class="sub-row"><ha-icon icon="mdi:timer-sand"></ha-icon>Full in ${timeToFull}</div>` : ""}
          ${!charging && status === "Discharging" && remaining ? `<div class="sub-row"><ha-icon icon="mdi:timer-sand"></ha-icon>${remaining} left</div>` : ""}
        </div>
        ${packCount !== null ? `
          <div class="pack-header">
            <ha-icon icon="mdi:battery-plus-variant"></ha-icon>
            ${packCount} Add-on Pack${packCount === 1 ? "" : "s"}
          </div>
        ` : ""}
        ${packs.length > 0 ? `
          <div class="packs">
            ${packs.map((p) => `
              <div class="pack-chip" title="${p.sn ? `Pack ${p.num} \u2014 SN ${p.sn}` : `Pack ${p.num}`}">
                <ha-icon icon="${this._batteryIcon(p.level, false)}"></ha-icon>
                <span>${Math.round(p.level)}%</span>
              </div>
            `).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  // -- Render -------------------------------------------------------------

  _render() {
    if (!this.shadowRoot) return;
    this._hasRendered = true;

    const title = this._config.title || "Battery Packs";
    const prefix = this._getDevicePrefix();

    if (!prefix) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          <div style="padding: 16px; text-align: center; color: var(--secondary-text-color);">
            No Jackery Transfer Switch entities found
          </div>
        </ha-card>
      `;
      return;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; box-sizing: border-box; font-family: var(--primary-font-family, Roboto, sans-serif); }
        ha-card { width: 100%; padding: 16px; box-sizing: border-box; container-type: inline-size; }
        .header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        .header h2 { margin: 0; flex: 1; font-size: 1.1em; font-weight: 500; color: var(--primary-text-color); }
        .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @container (max-width: 420px) {
          .columns { grid-template-columns: 1fr; }
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
        .empty-state {
          padding: 16px 0;
          text-align: center;
          font-size: 0.85em;
          color: var(--secondary-text-color);
        }
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
        .status-line {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          margin-top: 4px;
        }
        .sub-row {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.85em;
          color: var(--secondary-text-color);
        }
        .sub-row ha-icon { --mdc-icon-size: 16px; }
        .pack-header {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.8em;
          color: var(--secondary-text-color);
          margin-top: 12px;
          padding-top: 8px;
          border-top: 1px solid var(--divider-color, #e0e0e0);
        }
        .pack-header ha-icon { --mdc-icon-size: 16px; }
        .packs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .pack-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 8px;
          border-radius: 10px;
          font-size: 0.8em;
          font-weight: 500;
          background: var(--divider-color, #e0e0e0);
          color: var(--primary-text-color);
        }
        .pack-chip ha-icon { --mdc-icon-size: 14px; }
      </style>
      <ha-card>
        <div class="header">
          <h2>${title}</h2>
        </div>
        <div class="columns">
          ${this._renderSlot(prefix, "ac1")}
          ${this._renderSlot(prefix, "ac2")}
        </div>
      </ha-card>
    `;
  }

  getCardSize() {
    return 3;
  }

  getGridOptions() {
    return {
      columns: "full",
      min_columns: 6,
    };
  }
}

customElements.define("jackery-battery-pack-card", JackeryBatteryPackCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "jackery-battery-pack-card",
  name: "Jackery Battery Pack Status",
  description: "Side-by-side AC1/AC2 battery slot display with per-pack detail",
});
