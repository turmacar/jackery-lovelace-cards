# Jackery Lovelace Cards

Custom Lovelace cards for the [Jackery Home Assistant Integration](https://github.com/turmacar/jackery-homeassistant).

> **Requires** the [Jackery integration](https://github.com/turmacar/jackery-homeassistant) to be installed and configured first.

## Cards

### Transfer Switch Plan Card (`jackery-ts-plan-card`)

A custom card for managing charge/discharge plans on the Jackery Smart Transfer Switch.

**Features:**
- Create, edit, and delete charge/discharge plans directly from the HA UI
- Toggle individual plans on/off
- Drag-and-drop reordering (desktop and mobile)
- Organize plans with custom dividers
- Lock/unlock editing mode (default: locked)
- Cross-device persistence of plan order and lock state

## Installation

### HACS (Recommended)

1. Open HACS → Frontend
2. Click the three-dot menu → Custom repositories
3. Add `https://github.com/turmacar/jackery-lovelace-cards` as a **Lovelace** repository
4. Install **Jackery Lovelace Cards**
5. Restart Home Assistant

### Manual

1. Download `jackery-ts-plan-card.js` from the [latest release](https://github.com/turmacar/jackery-lovelace-cards/releases)
2. Copy it to `config/www/community/jackery/jackery-ts-plan-card.js`
3. Add the resource in **Settings → Dashboards → Resources**:
   - URL: `/local/community/jackery/jackery-ts-plan-card.js`
   - Type: JavaScript Module

## Configuration

Add the card to a dashboard:

```yaml
type: custom:jackery-plan-card
entity: sensor.jackery_<device>_scheduled_plans
```

Replace `<device>` with your Transfer Switch device name. If your device is named `transfer_switch` it should be found automatically.

## Prerequisites

- [Jackery Home Assistant Integration](https://github.com/turmacar/jackery-homeassistant) installed and configured
- A Jackery Smart Transfer Switch set up in the integration
