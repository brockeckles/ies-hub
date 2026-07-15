/**
 * IES Hub v3 — WSC Requirement Seam (W1 of the UX redesign, 2026-07-15)
 *
 * THE two-brains fix. Before this module, the N1–N5 basis chain (profile →
 * media → dynamics → layout) derived requirements that the sizing engine
 * never saw: Dashboard / 2D / 3D / chrome KPIs sized only from Configure's
 * separately-typed counts, so a 90%-design-ready profile still rendered a
 * 0 SF building until the user re-typed the numbers by hand.
 *
 * This seam derives the engine-facing volume inputs from APPLIED plans and
 * the design-basis profile, sitting between editor state and
 * calc.formStateToInputs (ui.js toSizingInputs — the single funnel every
 * view runs through). ENGINES FROZEN: calc.js is untouched; the seam only
 * fills UNASSERTED (0/blank) Configure fields the engine already honors.
 *
 * Rules (deal-wide precedent: explicit beats derived — Brock 2026-07-14):
 *   - volumes.totalPallets unasserted + APPLIED mediaPlan →
 *       profile.volumes.onHandPallets (raw pallets; the engine applies its
 *       own honeycomb/surge semantics — feeding the plan's occupancy-adjusted
 *       POSITIONS would double-count buffers), falling back to the plan's
 *       band-pallets total when the profile lacks an on-hand figure.
 *   - volumes.avgDailyInbound / avgDailyOutbound unasserted + APPLIED
 *       dynamicsPlan → plan flow.inPerDay / flow.outPerDay (avg, not peaked —
 *       the engine peaks dock math itself via its own inputs).
 *   - Anything the user typed (> 0) wins untouched.
 *   - Shelving locations deliberately NOT derived in W1: mediaPlan.shelving
 *       carries SKU/pallet-equivalents, not a defensible locations count.
 *
 * "Applied" gating: ui.js only assigns module-level mediaPlan/dynamicsPlan
 * inside applyMediaPlan/applyDynamicsPlan (previews live in ui-basis local
 * state), so plan presence here === the user clicked Apply. W5 upgrades
 * this to the explicit Adopt-flow.
 *
 * Zero-diff guarantee: with no applied plans (every pre-W1 scenario), the
 * input object is returned BY REFERENCE — formStateToInputs output is
 * byte-identical by construction.
 *
 * @module tools/warehouse-sizing/requirement-seam
 */

/**
 * @param {Object} args
 * @param {Object} args.volumes — WSC editor volumes state
 * @param {Object|null} [args.profile] — DesignProfile (N1)
 * @param {Object|null} [args.mediaPlan] — APPLIED media plan (N3)
 * @param {Object|null} [args.dynamicsPlan] — APPLIED dynamics plan (N4)
 * @returns {{ volumes: Object, active: boolean, fields: Object }}
 *   fields = { totalPallets|avgDailyInbound|avgDailyOutbound:
 *              { value, source: 'profile'|'mediaPlan'|'dynamicsPlan', detail } }
 */
export function deriveRequirement({ volumes = {}, profile = null, mediaPlan = null, dynamicsPlan = null } = {}) {
  const fields = {};

  // ── Storage requirement: on-hand peak pallets ──
  if (!(Number(volumes.totalPallets) > 0) && mediaPlan) {
    const fromProfile = Number(profile?.volumes?.onHandPallets) > 0
      ? Math.round(Number(profile.volumes.onHandPallets)) : 0;
    const fromPlan = Number(mediaPlan?.totals?.pallets) > 0
      ? Math.round(Number(mediaPlan.totals.pallets)) : 0;
    const pallets = fromProfile || fromPlan;
    if (pallets > 0) {
      fields.totalPallets = {
        value: pallets,
        source: fromProfile ? 'profile' : 'mediaPlan',
        detail: fromProfile
          ? `On-hand pallets (peak) from the Design Basis profile`
          : `Band-pallets total from the applied media plan`,
      };
    }
  }

  // ── Dock flow: avg pallets/day in + out ──
  const flow = dynamicsPlan?.flow || null;
  if (flow) {
    if (!(Number(volumes.avgDailyInbound) > 0) && Number(flow.inPerDay) > 0) {
      fields.avgDailyInbound = {
        value: Math.round(Number(flow.inPerDay)),
        source: 'dynamicsPlan',
        detail: 'Avg inbound pallets/day from the applied dynamics plan',
      };
    }
    if (!(Number(volumes.avgDailyOutbound) > 0) && Number(flow.outPerDay) > 0) {
      fields.avgDailyOutbound = {
        value: Math.round(Number(flow.outPerDay)),
        source: 'dynamicsPlan',
        detail: 'Avg outbound pallets/day from the applied dynamics plan',
      };
    }
  }

  const keys = Object.keys(fields);
  if (keys.length === 0) return { volumes, active: false, fields };

  const eff = { ...volumes };
  for (const k of keys) eff[k] = fields[k].value;
  return { volumes: eff, active: true, fields };
}
