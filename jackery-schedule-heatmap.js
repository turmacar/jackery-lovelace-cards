/**
 * Jackery Schedule Heatmap Card — Custom Lovelace card that shows a
 * 7-day × 24-hour grid of charge/discharge plan coverage for the
 * Jackery Smart Transfer Switch.
 *
 * Reads plan data from the same scheduled_plans sensor entity used
 * by the plan management card.
 */

const HEATMAP_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HEATMAP_DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

class JackeryScheduleHeatmapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._nowTimer = null;
    this._scheduleData = {};  // cached schedule.get_schedule responses
    this._scheduleDataLoaded = false;
  }

  connectedCallback() {
    this._startNowTimer();
    if (this._hass && this._config) this._render();
  }

  disconnectedCallback() {
    this._stopNowTimer();
  }

  _startNowTimer() {
    if (this._nowTimer) return;
    // Update current-time marker every 60s
    this._nowTimer = setInterval(() => this._render(), 60000);
  }

  _stopNowTimer() {
    if (this._nowTimer) {
      clearInterval(this._nowTimer);
      this._nowTimer = null;
    }
  }

  setConfig(config) {
    this._config = config;
    if (this._hass) this._render();
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;

    // On first hass or season change, fetch schedule data
    const seasonEntity = this._config.season_entity || 'input_select.avista_season';
    const seasonChanged = prev && prev.states[seasonEntity] !== hass.states[seasonEntity];
    if (!prev || seasonChanged) {
      this._scheduleDataLoaded = false;
      this._fetchScheduleData();
    }

    const entityId = this._resolveEntity();
    if (entityId && prev) {
      if (prev.states[entityId] === hass.states[entityId] && !seasonChanged) return;
    }
    this._render();
  }

  async _fetchScheduleData() {
    if (!this._hass) return;
    const schedules = this._resolveSchedules();
    if (schedules.length === 0) {
      this._scheduleDataLoaded = true;
      this._render();
      return;
    }
    const entities = schedules.map(s => s.entity).filter(Boolean);
    try {
      // callWS with return_response avoids callService signature drift across HA versions
      const result = await this._hass.callWS({
        type: 'call_service',
        domain: 'schedule',
        service: 'get_schedule',
        service_data: {},
        target: { entity_id: entities },
        return_response: true,
      });
      this._scheduleData = result?.response ?? result ?? {};
    } catch (e) {
      console.error('[jackery-schedule-heatmap] schedule.get_schedule failed:', e);
      this._scheduleData = {};
    }
    this._scheduleDataLoaded = true;
    this._render();
  }

  _resolveEntity() {
    if (this._config.entity) return this._config.entity;
    if (!this._hass) return null;
    return Object.keys(this._hass.states).find(
      k => k.includes("transfer_switch") && k.includes("scheduled_plans")
    ) || null;
  }

  _getPlans() {
    if (!this._hass) return [];
    const entityId = this._resolveEntity();
    if (!entityId) return [];
    const state = this._hass.states[entityId];
    if (!state) return [];
    const attrs = state.attributes;
    const count = attrs.plan_count || 0;
    const plans = [];
    for (let i = 1; i <= count; i++) {
      plans.push({
        pid: attrs[`plan_${i}_pid`] || "",
        name: attrs[`plan_${i}_name`] || "",
        enabled: attrs[`plan_${i}_enabled`] || false,
        type: attrs[`plan_${i}_type`] || "Discharge",
        start: attrs[`plan_${i}_start`] || "00:00",
        end: attrs[`plan_${i}_end`] || "00:00",
        day_mask: attrs[`plan_${i}_day_mask`] || "0000000",
      });
    }
    return plans;
  }

  /**
   * Build a coverage map: 7 days × 48 half-hour slots.
   * Each slot is null, "charge", "discharge", or "overlap".
   */
  _buildCoverage(plans) {
    // 7 days × 48 half-hour slots
    const grid = Array.from({ length: 7 }, () => new Array(48).fill(null));

    const enabledPlans = plans.filter(p => p.enabled);
    for (const plan of enabledPlans) {
      const startSlot = this._timeToSlot(plan.start);
      const endSlot = this._timeToSlot(plan.end);
      const type = plan.type === "Charge" ? "charge" : "discharge";

      for (let day = 0; day < 7; day++) {
        if (plan.day_mask[day] !== "1") continue;

        if (startSlot <= endSlot) {
          // Same-day span
          for (let s = startSlot; s < endSlot; s++) {
            grid[day][s] = this._mergeSlot(grid[day][s], type);
          }
        } else {
          // Overnight span: start→midnight, then midnight→end on next day
          for (let s = startSlot; s < 48; s++) {
            grid[day][s] = this._mergeSlot(grid[day][s], type);
          }
          const nextDay = (day + 1) % 7;
          // Only fill next day if plan is also active on next day or wrap is implied
          for (let s = 0; s < endSlot; s++) {
            grid[nextDay][s] = this._mergeSlot(grid[nextDay][s], type);
          }
        }
      }
    }
    return grid;
  }

  /**
   * Resolve which schedule overlays to show based on season + config.
   * Returns array of { entity, label, color } objects.
   */
  _resolveSchedules() {
    // If explicit schedules provided in config, use those
    if (this._config.schedules) {
      return this._config.schedules.map(s => ({
        entity: s.entity,
        label: s.label || this._entityToLabel(s.entity),
        color: s.color || 'rgba(219, 68, 55, 0.25)',
      }));
    }
    // Auto-detect from season
    if (!this._hass) return [];
    const seasonEntity = this._config.season_entity || 'input_select.avista_season';
    const seasonState = this._hass.states[seasonEntity];
    const season = seasonState ? seasonState.state.toLowerCase() : null;
    const result = [];
    if (season === 'summer') {
      result.push({ entity: 'schedule.avista_on_peak_summer', label: 'On-Peak', color: 'rgba(219, 68, 55, 0.25)' });
      result.push({ entity: 'schedule.avista_morning_discount_summer', label: 'Discount', color: 'rgba(33, 150, 243, 0.25)' });
    } else if (season === 'winter') {
      result.push({ entity: 'schedule.avista_on_peak_winter', label: 'On-Peak', color: 'rgba(219, 68, 55, 0.25)' });
    }
    return result;
  }

  _entityToLabel(entityId) {
    if (!this._hass || !entityId) return entityId;
    const state = this._hass.states[entityId];
    return state ? (state.attributes.friendly_name || entityId) : entityId;
  }

  /**
   * Build a schedule overlay grid: 7 days × 48 slots.
   * Each slot gets an array of schedule labels that cover it.
   * Returns { grid: string[][], schedules: [{label, color}] }
   */
  _buildScheduleOverlay() {
    const grid = Array.from({ length: 7 }, () => new Array(48).fill(null));
    const schedules = this._resolveSchedules();
    if (!this._scheduleDataLoaded || schedules.length === 0) return { grid, schedules };

    for (const sched of schedules) {
      const schedData = this._scheduleData[sched.entity];
      if (!schedData) continue;
      for (let day = 0; day < 7; day++) {
        const dayKey = HEATMAP_DAY_KEYS[day];
        const windows = schedData[dayKey];
        if (!windows || !Array.isArray(windows)) continue;
        for (const win of windows) {
          const fromSlot = this._timeToSlot(win.from);
          const toSlot = this._timeToSlot(win.to);
          for (let s = fromSlot; s < toSlot; s++) {
            grid[day][s] = sched;
          }
        }
      }
    }
    return { grid, schedules };
  }

  _timeToSlot(timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    return h * 2 + (m >= 30 ? 1 : 0);
  }

  _timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    return h * 60 + m;
  }

  _mergeSlot(existing, incoming) {
    if (!existing) return incoming;
    if (existing === incoming) return existing;
    return "overlap";
  }

  _getNowPosition() {
    const now = new Date();
    const tz = this._hass?.config?.time_zone;
    let day, hours, minutes;
    if (tz) {
      // Use HA's configured timezone rather than the browser's local timezone
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).formatToParts(now).map(p => [p.type, p.value])
      );
      const weekdayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
      day = weekdayMap[parts.weekday] ?? 0;
      hours = parseInt(parts.hour, 10) % 24; // normalize 24 → 0 at midnight
      minutes = parseInt(parts.minute, 10);
    } else {
      // Fallback to browser local time if HA config is unavailable
      const jsDay = now.getDay();
      day = jsDay === 0 ? 6 : jsDay - 1;
      hours = now.getHours();
      minutes = now.getMinutes();
    }
    const slot = hours * 2 + (minutes >= 30 ? 1 : 0);
    const minuteInSlot = minutes % 30;
    const pct = minuteInSlot / 30;
    return { day, slot, pct };
  }

  _getSummary(plans) {
    const enabled = plans.filter(p => p.enabled);
    const chargeCount = enabled.filter(p => p.type === "Charge").length;
    const dischargeCount = enabled.filter(p => p.type === "Discharge").length;
    return { total: plans.length, enabled: enabled.length, chargeCount, dischargeCount };
  }

  _render() {
    if (!this.shadowRoot) return;
    const plans = this._getPlans();
    const grid = this._buildCoverage(plans);
    const now = this._getNowPosition();
    const summary = this._getSummary(plans);
    const title = this._config.title || "Schedule Heatmap";
    const showPlans = this._config.show_plans !== false;
    const overlay = this._buildScheduleOverlay();

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: var(--primary-font-family, Roboto, sans-serif);
        }
        ha-card {
          padding: 16px;
          container-type: inline-size;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }
        .header h2 {
          margin: 0;
          font-size: 1.1em;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        .summary {
          font-size: 0.8em;
          color: var(--secondary-text-color);
          display: flex;
          gap: 12px;
        }
        .summary-item {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .summary-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
        }
        .heatmap-container {
          overflow-x: auto;
        }
        .heatmap {
          display: grid;
          grid-template-columns: 48px repeat(48, 1fr);
          grid-template-rows: auto repeat(7, 28px);
          gap: 1px;
          min-width: 500px;
        }
        @container (max-width: 500px) {
          .heatmap {
            min-width: 0;
            grid-template-columns: 32px repeat(48, 1fr);
          }
          .hour-label {
            font-size: 0.55em;
          }
          .day-label {
            font-size: 0.65em;
          }
        }
        .hour-label {
          font-size: 0.65em;
          color: var(--secondary-text-color);
          text-align: center;
          padding: 2px 0;
          grid-row: 1;
        }
        .hour-label:nth-child(odd) {
          /* Only show labels on even hours */
        }
        .corner {
          grid-row: 1;
          grid-column: 1;
        }
        .day-label {
          font-size: 0.75em;
          font-weight: 500;
          color: var(--secondary-text-color);
          display: flex;
          align-items: center;
          padding-right: 8px;
          grid-column: 1;
        }
        .day-label.today {
          color: var(--primary-color, #03a9f4);
          font-weight: 600;
        }
        .cell {
          border-radius: 2px;
          min-height: 28px;
          position: relative;
        }
        .cell.empty {
          background: var(--divider-color, rgba(127, 127, 127, 0.15));
        }
        .cell.empty.schedule-bg {
          background: var(--schedule-bg);
        }
        .cell.charge {
          background: rgba(76, 175, 80, 0.7);
        }
        .cell.charge.schedule-bg {
          background: linear-gradient(to bottom, rgba(76, 175, 80, 0.7), rgba(76, 175, 80, 0.7)), var(--schedule-bg);
        }
        .cell.discharge {
          background: rgba(255, 152, 0, 0.7);
        }
        .cell.discharge.schedule-bg {
          background: linear-gradient(to bottom, rgba(255, 152, 0, 0.7), rgba(255, 152, 0, 0.7)), var(--schedule-bg);
        }
        .cell.overlap {
          background: repeating-linear-gradient(
            135deg,
            rgba(76, 175, 80, 0.7),
            rgba(76, 175, 80, 0.7) 4px,
            rgba(255, 152, 0, 0.7) 4px,
            rgba(255, 152, 0, 0.7) 8px
          );
        }
        .cell .schedule-stripe {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          height: 7px;
          pointer-events: none;
        }
        .now-marker {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 2px;
          background: #fff;
          box-shadow: 0 0 3px 1px rgba(0, 0, 0, 0.6);
          z-index: 2;
          pointer-events: none;
        }
        .now-dot {
          position: absolute;
          top: -3px;
          left: -3px;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 0 3px 1px rgba(0, 0, 0, 0.6);
        }
        .legend {
          display: flex;
          gap: 16px;
          margin-top: 12px;
          justify-content: center;
          flex-wrap: wrap;
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 0.75em;
          color: var(--secondary-text-color);
        }
        .legend-swatch {
          width: 14px;
          height: 14px;
          border-radius: 3px;
        }
        .legend-swatch.charge { background: rgba(76, 175, 80, 0.7); }
        .legend-swatch.discharge { background: rgba(255, 152, 0, 0.7); }
        .legend-swatch.overlap {
          background: repeating-linear-gradient(
            135deg,
            rgba(76, 175, 80, 0.7),
            rgba(76, 175, 80, 0.7) 3px,
            rgba(255, 152, 0, 0.7) 3px,
            rgba(255, 152, 0, 0.7) 6px
          );
        }
        .legend-swatch.now {
          width: 2px;
          height: 14px;
          background: #fff;
          box-shadow: 0 0 2px 1px rgba(0, 0, 0, 0.4);
          border-radius: 1px;
        }
        .no-plans {
          text-align: center;
          color: var(--secondary-text-color);
          padding: 24px 0;
          font-size: 0.9em;
        }
        .plan-list {
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--divider-color, #e0e0e0);
        }
        .plan-list-title {
          font-size: 0.75em;
          color: var(--secondary-text-color);
          margin-bottom: 6px;
          font-weight: 500;
        }
        .plan-list-item {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.75em;
          color: var(--primary-text-color);
          padding: 2px 0;
        }
        .plan-list-item .type-icon {
          font-size: 0.85em;
        }
        .plan-list-item .type-label.charge {
          color: #4CAF50;
        }
        .plan-list-item .type-label.discharge {
          color: #FF9800;
        }
        .plan-list-item .plan-days {
          color: var(--secondary-text-color);
          font-size: 0.9em;
        }
      </style>
      <ha-card>
        <div class="header">
          <h2>${title}</h2>
          <div class="summary">
            ${summary.chargeCount > 0 ? `<span class="summary-item"><span class="summary-dot" style="background:#4CAF50"></span>${summary.chargeCount} charge</span>` : ''}
            ${summary.dischargeCount > 0 ? `<span class="summary-item"><span class="summary-dot" style="background:#FF9800"></span>${summary.dischargeCount} discharge</span>` : ''}
          </div>
        </div>
        ${plans.length === 0 ? '<div class="no-plans">No plans configured</div>' : `
          <div class="heatmap-container">
            <div class="heatmap">
              <div class="corner"></div>
              ${this._renderHourLabels()}
              ${this._renderGrid(grid, now, overlay.grid)}
            </div>
          </div>
          <div class="legend">
            <div class="legend-item"><div class="legend-swatch charge"></div>Charge</div>
            <div class="legend-item"><div class="legend-swatch discharge"></div>Discharge</div>
            <div class="legend-item"><div class="legend-swatch overlap"></div>Overlap</div>
            <div class="legend-item"><div class="legend-swatch now"></div>Now</div>
            ${overlay.schedules.map(s => `<div class="legend-item"><div class="legend-swatch" style="background:${s.color}"></div>${s.label}</div>`).join('')}
          </div>
          ${showPlans ? this._renderActivePlans(plans) : ''}
        `}
      </ha-card>
    `;
  }

  _renderHourLabels() {
    let html = '';
    for (let slot = 0; slot < 48; slot++) {
      const hour = Math.floor(slot / 2);
      // Show label only on even hours, at the :00 slot
      const label = (slot % 2 === 0 && hour % 2 === 0) ? `${hour}` : '';
      const col = slot + 2; // +2 because col 1 is day labels
      html += `<div class="hour-label" style="grid-column:${col}">${label}</div>`;
    }
    return html;
  }

  _renderGrid(grid, now, scheduleGrid) {
    let html = '';
    for (let day = 0; day < 7; day++) {
      const isToday = day === now.day;
      const row = day + 2; // +2 because row 1 is hour labels
      html += `<div class="day-label${isToday ? ' today' : ''}" style="grid-row:${row}">${HEATMAP_DAY_LABELS[day]}</div>`;
      for (let slot = 0; slot < 48; slot++) {
        const type = grid[day][slot];
        const cls = type || 'empty';
        const col = slot + 2;
        const sched = scheduleGrid[day][slot];
        const hasBg = sched ? ' schedule-bg' : '';
        const bgStyle = sched ? ` --schedule-bg:${sched.color};` : '';
        let inner = '';
        if (sched) {
          inner += `<div class="schedule-stripe" style="background:${sched.color.replace('0.25', '0.8')}"></div>`;
        }
        if (isToday && slot === now.slot) {
          const leftPct = now.pct * 100;
          inner += `<div class="now-marker" style="left:${leftPct}%"><div class="now-dot"></div></div>`;
        }
        html += `<div class="cell ${cls}${hasBg}" style="grid-row:${row};grid-column:${col};${bgStyle}">${inner}</div>`;
      }
    }
    return html;
  }

  _renderActivePlans(plans) {
    const active = plans.filter(p => p.enabled)
      .sort((a, b) => this._timeToMinutes(a.start) - this._timeToMinutes(b.start));
    if (active.length === 0) return '';
    return `
      <div class="plan-list">
        <div class="plan-list-title">Active plans</div>
        ${active.map(p => {
          const icon = p.type === "Charge" ? "🔋" : "⚡";
          const typeCls = p.type === "Charge" ? "charge" : "discharge";
          const days = this._formatDays(p.day_mask);
          return `<div class="plan-list-item">
            <span class="type-icon">${icon}</span>
            <span class="type-label ${typeCls}">${p.type}</span>
            <span>${p.start}–${p.end}</span>
            <span class="plan-days">${days}</span>
          </div>`;
        }).join('')}
      </div>
    `;
  }

  _formatDays(mask) {
    if (mask === "1111111") return "Daily";
    if (mask === "1111100") return "Weekdays";
    if (mask === "0000011") return "Weekends";
    const days = [];
    for (let i = 0; i < 7; i++) {
      if (mask[i] === "1") days.push(HEATMAP_DAY_LABELS[i]);
    }
    return days.join(", ");
  }

  getCardSize() {
    return 4;
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6 };
  }

  static getStubConfig() {
    return {};
  }
}

customElements.define("jackery-schedule-heatmap", JackeryScheduleHeatmapCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "jackery-schedule-heatmap",
  name: "Jackery Schedule Heatmap",
  description: "7-day × 24-hour heatmap of Jackery Transfer Switch charge/discharge plan coverage",
});
