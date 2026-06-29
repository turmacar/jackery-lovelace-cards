/**
 * Jackery Circuit Panel Card — Custom Lovelace card for visualizing
 * and controlling Transfer Switch circuits in a breaker-panel layout.
 *
 * Auto-discovers circuit entities by device name prefix, or accepts
 * manual configuration via `device_prefix`.
 */

class JackeryCircuitPanelCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._locked = true;
    this._cachedCircuits = [];
  }

  connectedCallback() {
    if (this._hass && this._config) this._render();
  }

  disconnectedCallback() {
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
  }

  setConfig(config) {
    this._config = config;
    if (this._hass) this._render();
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!prev && hass) {
      this._loadLock();
      this._render();
      this._startRetry();
    } else if (prev && (this._circuitsChanged(prev, hass) || !this._hasRenderedCircuits)) {
      this._render();
    }
  }

  _startRetry() {
    if (this._retryTimer) return;
    this._retryTimer = setInterval(() => {
      if (this._hasRenderedCircuits) {
        clearInterval(this._retryTimer);
        this._retryTimer = null;
        return;
      }
      this._render();
    }, 2000);
  }

  async _loadLock() {
    if (!this._hass) return;
    try {
      const result = await this._hass.callWS({ type: "frontend/get_user_data", key: "jackery_circuit_locked" });
      // Default to locked if no saved value
      this._locked = (result && result.value !== undefined && result.value !== null) ? !!result.value : true;
      this._render();
    } catch { /* default locked */ }
  }

  _toggleLock() {
    this._locked = !this._locked;
    if (this._hass) {
      this._hass.callWS({ type: "frontend/set_user_data", key: "jackery_circuit_locked", value: this._locked }).catch(() => {});
    }
    this._render();
  }

  _circuitsChanged(prev, curr) {
    // Check all circuit-related entities for any state change
    const prefix = this._getDevicePrefix();
    if (!prefix) return false;
    const pattern = `${prefix}_circuit_`;
    for (const key of Object.keys(curr.states)) {
      if (key.includes(pattern) && prev.states[key] !== curr.states[key]) return true;
    }
    return false;
  }

  _getDevicePrefix() {
    if (this._config.device_prefix) return this._config.device_prefix;
    // Derive prefix from entity config
    if (this._config.entity) {
      const eid = this._config.entity;
      const idx = eid.indexOf('_circuit_');
      if (idx > 0) {
        const dotIdx = eid.indexOf('.');
        return dotIdx >= 0 ? eid.substring(dotIdx + 1, idx) : eid.substring(0, idx);
      }
    }
    if (!this._hass) return null;
    // Auto-discover: find any entity matching *transfer_switch*circuit*power
    const match = Object.keys(this._hass.states).find(
      k => k.startsWith("sensor.") && k.includes("circuit") && k.endsWith("_power")
        && k.includes("transfer_switch")
    );
    if (!match) return null;
    // Extract prefix: everything before "circuit_"
    const idx = match.indexOf("_circuit_");
    return idx > 0 ? match.substring(7, idx) : null; // strip "sensor."
  }

  _getCircuits() {
    if (!this._hass) return [];
    const prefix = this._getDevicePrefix();
    if (!prefix) return [];

    const circuits = [];
    const sensorPrefix = `sensor.${prefix}_circuit_`;
    const switchPrefix = `switch.${prefix}_circuit_`;

    // Find all circuit power sensors
    const powerEntities = Object.keys(this._hass.states)
      .filter(k => k.startsWith(sensorPrefix) && k.endsWith("_power"))
      .sort();

    for (const powerEntity of powerEntities) {
      // Extract circuit name: between prefix_circuit_ and _power
      const afterPrefix = powerEntity.substring(sensorPrefix.length);
      const circuitSlug = afterPrefix.replace(/_power$/, "");

      const switchEntity = `${switchPrefix}${circuitSlug}`;
      const powerState = this._hass.states[powerEntity];
      const switchState = this._hass.states[switchEntity];

      // Get short name: prefer circuit_name attribute, fall back to slug
      let name;
      if (powerState && powerState.attributes.circuit_name) {
        name = "Circuit " + powerState.attributes.circuit_name;
      } else if (switchState && switchState.attributes.circuit_name) {
        name = "Circuit " + switchState.attributes.circuit_name;
      } else {
        name = "Circuit " + circuitSlug.replace(/_/g, " ");
      }

      const power = powerState ? parseFloat(powerState.state) : null;
      const switchUnavailable = switchState && (switchState.state === "unavailable" || switchState.state === "unknown");
      const isOn = switchState ? (switchUnavailable ? null : switchState.state === "on") : null;
      const stateAvailable = powerState && powerState.state !== "unavailable" && powerState.state !== "unknown";
      const combined = powerState?.attributes?.combined === true;
      const circuitIndex = powerState?.attributes?.circuit_index;
      const partnerIndex = powerState?.attributes?.split_phase_partner || null;

      circuits.push({
        name,
        circuitSlug,
        circuitIndex: circuitIndex || parseInt(circuitSlug) || 0,
        partnerIndex,
        power: isNaN(power) ? null : power,
        isOn,
        stateAvailable,
        combined,
        powerEntity,
        switchEntity: this._hass.states[switchEntity] ? switchEntity : null,
      });
    }

    // Sort by circuit index
    circuits.sort((a, b) => a.circuitIndex - b.circuitIndex);

    // Merge with cached data: use cached values for any circuit with unavailable state
    // This prevents flickering of power values when the integration is temporarily unavailable
    if (this._cachedCircuits.length > 0) {
      const cacheMap = new Map(this._cachedCircuits.map(c => [c.circuitIndex, c]));
      for (const c of circuits) {
        if (!c.stateAvailable) {
          const cached = cacheMap.get(c.circuitIndex);
          if (cached) {
            // If switch is off, show 0W; otherwise use cached power
            c.power = c.isOn === false ? 0 : cached.power;
            if (c.isOn === null) c.isOn = cached.isOn;
          }
        }
      }
    }
    // Update cache with current good data
    this._cachedCircuits = circuits.map(c => ({ ...c }));

    return circuits;
  }

  _getPowerLevel(power) {
    if (power === null || power === undefined) return "unknown";
    if (power === 0) return "off";
    if (power < 100) return "low";
    if (power < 500) return "medium";
    if (power < 1500) return "high";
    return "critical";
  }

  _getPowerColor(level) {
    switch (level) {
      case "off": return "var(--disabled-text-color, #9e9e9e)";
      case "low": return "#4CAF50";
      case "medium": return "#FF9800";
      case "high": return "#f44336";
      case "critical": return "#b71c1c";
      default: return "var(--disabled-text-color, #9e9e9e)";
    }
  }

  async _toggleCircuit(switchEntity) {
    if (!this._hass || !switchEntity) return;
    const state = this._hass.states[switchEntity];
    if (!state) return;
    const service = state.state === "on" ? "turn_off" : "turn_on";
    try {
      await this._hass.callService("switch", service, {
        entity_id: switchEntity,
      });
      // Schedule re-renders to pick up updated states without waiting for full integration refresh
      setTimeout(() => this._render(), 1500);
      setTimeout(() => this._render(), 4000);
    } catch (e) {
      console.error("[jackery-circuit-panel] toggle error", e);
    }
  }

  _render() {
    if (!this.shadowRoot) return;
    const circuits = this._getCircuits();
    const title = this._config.title || "Circuit Panel";

    // Split into two banks: odd (A) and even (B)
    const bankA = circuits.filter(c => c.circuitIndex % 2 === 1);
    const bankB = circuits.filter(c => c.circuitIndex % 2 === 0);

    // Build a map of combined circuits for partner slot rendering
    this._combinedMap = new Map();
    for (const c of circuits) {
      if (c.combined && c.partnerIndex) {
        this._combinedMap.set(c.partnerIndex, c);
      }
    }

    // Track whether we've successfully found circuits (stops retry re-renders)
    this._hasRenderedCircuits = circuits.length > 0;

    // Total power
    const totalPower = circuits.reduce((sum, c) => sum + (c.power || 0), 0);
    const activeCount = circuits.filter(c => c.isOn).length;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: var(--primary-font-family, Roboto, sans-serif);
        }
        ha-card {
          padding: 16px;
          box-sizing: border-box;
          height: 100%;
          container-type: inline-size;
        }
        .header {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }
        .header h2 {
          margin: 0;
          font-size: 1.1em;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        .header-stats {
          font-size: 0.85em;
          color: var(--secondary-text-color);
        }
        .header-stats .power-total {
          font-weight: 600;
          color: var(--primary-text-color);
        }
        .panel {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          grid-template-rows: auto repeat(6, minmax(48px, auto));
          gap: 6px 8px;
          align-items: stretch;
        }
        @container (max-width: 500px) {
          .panel {
            grid-template-columns: 1fr;
            grid-template-rows: auto;
            grid-auto-rows: minmax(48px, auto);
          }
          .breaker-divider { display: none; }
          .panel > * { grid-column: 1 !important; grid-row: auto !important; }
          .panel > [data-bank="a"] { order: 1; }
          .panel > [data-bank="b"] { order: 3; }
          .panel > .bank-label[data-bank="a"] { order: 0; }
          .panel > .bank-label[data-bank="b"] { order: 2; }
        }
        .bank-label {
          font-size: 0.75em;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--secondary-text-color);
          text-align: center;
          align-self: end;
          padding-bottom: 4px;
        }
        .breaker-divider {
          width: 4px;
          background: var(--divider-color, #424242);
          border-radius: 2px;
        }
        .breaker {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border-radius: 10px;
          background: var(--card-background-color, var(--secondary-background-color));
          border: 1px solid var(--divider-color, #e0e0e0);
          transition: border-color 0.2s;
          min-height: 42px;
          width: 100%;
          box-sizing: border-box;
        }
        .breaker.on {
          border-color: var(--primary-color, #03a9f4);
        }
        .breaker-idx {
          font-size: 0.7em;
          font-weight: 700;
          color: var(--secondary-text-color);
          min-width: 18px;
          text-align: center;
        }
        .breaker-status {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .breaker-info {
          flex: 1;
          min-width: 0;
        }
        .breaker-name {
          font-size: 0.85em;
          font-weight: 500;
          color: var(--primary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .breaker-power {
          font-size: 0.75em;
          color: var(--secondary-text-color);
          font-variant-numeric: tabular-nums;
        }
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
        .breaker.combined .breaker-idx {
          font-style: italic;
        }
        .breaker.combined-double {
          border-width: 2px;
        }
        .breaker-idx-pair {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1px;
          font-size: 0.7em;
          font-weight: 700;
          color: var(--secondary-text-color);
          min-width: 18px;
          --mdc-icon-size: 12px;
        }
        .empty-slot {
          padding: 8px 10px;
          border-radius: 10px;
          border: 1px dashed var(--divider-color, #e0e0e0);
          min-height: 42px;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          box-sizing: border-box;
        }
        .empty-slot span {
          font-size: 0.75em;
          color: var(--disabled-text-color, #9e9e9e);
        }
        .no-circuits {
          text-align: center;
          color: var(--secondary-text-color);
          padding: 24px 0;
          font-size: 0.9em;
        }
        .power-bar {
          height: 3px;
          background: var(--divider-color, #e0e0e0);
          border-radius: 2px;
          margin-top: 4px;
          overflow: hidden;
        }
        .power-bar-fill {
          height: 100%;
          border-radius: 2px;
          transition: width 0.3s;
        }
      </style>
      <ha-card>
        <div class="header">
          <h2>${title}</h2>
          <div class="header-stats">
            <span class="power-total">${Math.round(totalPower)} W</span>
            · ${activeCount}/${circuits.length} on
          </div>
          <button class="lock-btn" id="lock-btn" title="${this._locked ? 'Unlock controls' : 'Lock controls'}"><ha-icon icon="${this._locked ? 'mdi:lock' : 'mdi:lock-open-variant'}"></ha-icon></button>
        </div>
        ${circuits.length === 0
          ? '<div class="no-circuits">No circuit entities found</div>'
          : `<div class="panel">
              <div class="bank-label" data-bank="a" style="grid-column: 1; grid-row: 1;">Bank A</div>
              <div class="breaker-divider" style="grid-column: 2; grid-row: 1 / -1;"></div>
              <div class="bank-label" data-bank="b" style="grid-column: 3; grid-row: 1;">Bank B</div>
              ${this._renderBankItems(bankA, [1, 3, 5, 7, 9, 11], 1)}
              ${this._renderBankItems(bankB, [2, 4, 6, 8, 10, 12], 3)}
            </div>`
        }
      </ha-card>
    `;

    // Bind lock button
    this.shadowRoot.getElementById("lock-btn")?.addEventListener("click", () => {
      this._toggleLock();
    });

    // Bind toggle events (only when unlocked)
    if (!this._locked) {
      this.shadowRoot.querySelectorAll("ha-switch[data-switch]").forEach(sw => {
        sw.addEventListener("change", () => {
          this._toggleCircuit(sw.dataset.switch);
        });
      });
    }
  }

  _renderBankItems(circuits, slots, gridColumn) {
    const byIndex = new Map();
    for (const c of circuits) {
      byIndex.set(c.circuitIndex, c);
    }

    // Track which slots are consumed by a combined breaker
    const consumed = new Set();

    let html = "";
    for (let si = 0; si < slots.length; si++) {
      const i = slots[si];
      if (consumed.has(i)) continue;

      const gridRow = si + 2; // row 1 is bank labels
      const c = byIndex.get(i);
      if (c) {
        // Check if this is a combined circuit whose partner is also in this bank
        if (c.combined && c.partnerIndex && slots.includes(c.partnerIndex)) {
          consumed.add(c.partnerIndex);
          html += this._renderCombinedBreaker(c, gridColumn, gridRow);
        } else {
          html += this._renderBreaker(c, gridColumn, gridRow);
        }
        continue;
      }
      // Check if this slot is a partner of a combined circuit in this bank
      const primary = this._combinedMap.get(i);
      if (primary && slots.includes(primary.circuitIndex)) {
        // Will be rendered as part of the combined breaker — skip
        continue;
      }
      html += `<div class="empty-slot" data-bank="${gridColumn === 1 ? 'a' : 'b'}" style="grid-column: ${gridColumn}; grid-row: ${gridRow};"><span>${i}</span></div>`;
    }
    return html;
  }

  _renderCombinedBreaker(circuit, gridColumn, gridRow) {
    const level = this._getPowerLevel(circuit.power);
    const color = this._getPowerColor(level);
    const powerDisplay = circuit.power !== null ? `${Math.round(circuit.power)} W` : "\u2014";
    const onClass = circuit.isOn ? "on" : (circuit.isOn === false ? "off" : "");
    const barWidth = circuit.power !== null ? Math.min((circuit.power / 2000) * 100, 100) : 0;

    return `
      <div class="breaker combined-double ${onClass}" data-bank="${gridColumn === 1 ? 'a' : 'b'}" title="${circuit.name} (split-phase ${circuit.circuitIndex} + ${circuit.partnerIndex})" style="grid-column: ${gridColumn}; grid-row: ${gridRow} / span 2;">
        <div class="breaker-idx-pair">
          <span>${circuit.circuitIndex}</span>
          <ha-icon icon="mdi:link-variant" style="--mdc-icon-size: 12px;"></ha-icon>
          <span>${circuit.partnerIndex}</span>
        </div>
        <div class="breaker-status" style="background: ${circuit.isOn ? color : 'var(--disabled-text-color, #9e9e9e)'}"></div>
        <div class="breaker-info">
          <div class="breaker-name">${circuit.name}</div>
          <div class="breaker-power">${powerDisplay} · 240V</div>
          ${circuit.isOn && circuit.power > 0 ? `
            <div class="power-bar">
              <div class="power-bar-fill" style="width: ${barWidth}%; background: ${color}"></div>
            </div>
          ` : ''}
        </div>
        <ha-switch ${circuit.isOn ? 'checked' : ''} ${(!circuit.switchEntity || this._locked) ? 'disabled' : ''}
          ${circuit.switchEntity && !this._locked ? `data-switch="${circuit.switchEntity}"` : ''}
        ></ha-switch>
      </div>
    `;
  }

  _renderBreaker(circuit, gridColumn, gridRow) {
    const level = this._getPowerLevel(circuit.power);
    const color = this._getPowerColor(level);
    const powerDisplay = circuit.power !== null ? `${Math.round(circuit.power)} W` : "—";
    const onClass = circuit.isOn ? "on" : (circuit.isOn === false ? "off" : "");

    // Power bar: scale to 2000W max for visual
    const barWidth = circuit.power !== null ? Math.min((circuit.power / 2000) * 100, 100) : 0;

    return `
      <div class="breaker ${onClass} ${circuit.combined ? 'combined' : ''}" data-bank="${gridColumn === 1 ? 'a' : 'b'}" title="${circuit.name}" style="grid-column: ${gridColumn}; grid-row: ${gridRow};">
        <div class="breaker-idx">${circuit.circuitIndex}</div>
        <div class="breaker-status" style="background: ${circuit.isOn ? color : 'var(--disabled-text-color, #9e9e9e)'}"></div>
        <div class="breaker-info">
          <div class="breaker-name">${circuit.name}</div>
          <div class="breaker-power">${powerDisplay}</div>
          ${circuit.isOn && circuit.power > 0 ? `
            <div class="power-bar">
              <div class="power-bar-fill" style="width: ${barWidth}%; background: ${color}"></div>
            </div>
          ` : ''}
        </div>
        <ha-switch ${circuit.isOn ? 'checked' : ''} ${(!circuit.switchEntity || this._locked) ? 'disabled' : ''}
          ${circuit.switchEntity && !this._locked ? `data-switch="${circuit.switchEntity}"` : ''}
        ></ha-switch>
      </div>
    `;
  }

  getCardSize() {
    return 5;
  }

  getGridOptions() {
    return {
      columns: "full",
      min_columns: 6,
    };
  }

  static getStubConfig() {
    return {};
  }
}

customElements.define("jackery-circuit-panel", JackeryCircuitPanelCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "jackery-circuit-panel",
  name: "Jackery Circuit Panel",
  description: "Breaker-panel layout for Jackery Transfer Switch circuits with power monitoring and on/off control",
});
