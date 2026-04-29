/**
 * IES Hub v3 — Cost Model Channel Accessors
 *
 * Phase 1 of the volumes-as-nucleus redesign (2026-04-29). See
 * `project_volumes_nucleus_redesign.md` in auto-memory for the architecture.
 *
 * These accessors are the canonical way to read volume data going forward.
 * Phase 3 will migrate every consumer of `model.volumeLines` and
 * `model.orderProfile` to call into here. Phase 1 is silent — accessors
 * exist but nothing calls them yet, so behavior is unchanged.
 *
 * Robust-to-either-shape: accessors work on a model with `channels[]`
 * already populated (post-migration) OR on a legacy model with `volumeLines`
 * + `orderProfile` + `seasonalityProfile` (synthesizes one channel on read).
 *
 * @module tools/cost-model/calc.channels
 */

// ────────────────────────────────────────────────────────────────
// Defaults — used when a channel is missing structural fields. These
// are lower-fidelity than the master_channel_archetypes seed defaults;
// they exist so accessors return sensible numbers on partial data.
// ────────────────────────────────────────────────────────────────

const DEFAULT_CONVERSIONS = {
  unitsPerCase: 12,
  casesPerPallet: 40,
  linesPerOrder: 2,
  unitsPerLine: 5,
  weightPerUnit: 1,
  weightUnit: 'lbs',
};

const DEFAULT_ASSUMPTIONS = {
  returnsPercent: 5,
  inboundOutboundRatio: 1.0,
  peakSurgeFactor: 1.5,
};

const DEFAULT_FLAT_SEASONALITY = {
  preset: 'flat',
  monthly_shares: Array.from({ length: 12 }, () => 1 / 12),
};

// Conversion factors between UOMs, derived from the conversion table.
// Returns multiplier `value_in_toUom = value_in_fromUom × multiplier`.
function uomMultiplier(fromUom, toUom, conv) {
  if (fromUom === toUom) return 1;
  const c = { ...DEFAULT_CONVERSIONS, ...(conv || {}) };
  // Express everything in units, then convert to toUom.
  const toUnits = {
    units: 1,
    each: 1,
    eaches: 1,
    case: c.unitsPerCase,
    cases: c.unitsPerCase,
    pallet: c.unitsPerCase * c.casesPerPallet,
    pallets: c.unitsPerCase * c.casesPerPallet,
    line: c.unitsPerLine,
    lines: c.unitsPerLine,
    order: c.unitsPerLine * c.linesPerOrder,
    orders: c.unitsPerLine * c.linesPerOrder,
  };
  const fromMult = toUnits[fromUom];
  const toMult = toUnits[toUom];
  if (!fromMult || !toMult) return NaN;
  return fromMult / toMult;
}

/**
 * Convert a numeric value from one UOM to another using channel conversions.
 * @param {number} value
 * @param {string} fromUom
 * @param {string} toUom
 * @param {Object} [conversions]
 * @returns {number}
 */
export function convertUom(value, fromUom, toUom, conversions) {
  const v = Number(value) || 0;
  return v * uomMultiplier(fromUom, toUom, conversions);
}

// ────────────────────────────────────────────────────────────────
// Synthesis from legacy shape — when channels[] is absent, derive a
// single-channel view from volumeLines + orderProfile + seasonalityProfile.
// Used internally by getChannels() so callers never see legacy shape.
// ────────────────────────────────────────────────────────────────

function synthesizeChannelFromLegacy(model) {
  const volumeLines = Array.isArray(model.volumeLines) ? model.volumeLines : [];
  const orderProfile = model.orderProfile || {};
  const seasonality = model.seasonalityProfile || DEFAULT_FLAT_SEASONALITY;

  // Pick the primary row: starred, else first row, else null.
  const primaryRow = volumeLines.find(v => v.isOutboundPrimary) || volumeLines[0] || null;

  const primary = primaryRow
    ? {
        value: Number(primaryRow.volume) || 0,
        uom: normalizeUom(primaryRow.uom),
        activity: 'outbound',
        source: 'manual',
      }
    : { value: 0, uom: 'units', activity: 'outbound', source: 'manual' };

  // Conversions: orderProfile carries lines/order + units/line. Other
  // fields fall to defaults — designer can edit on first walkthrough of
  // the new page in Phase 2.
  const conversions = {
    unitsPerCase: DEFAULT_CONVERSIONS.unitsPerCase,
    casesPerPallet: DEFAULT_CONVERSIONS.casesPerPallet,
    linesPerOrder: Number(orderProfile.linesPerOrder) || DEFAULT_CONVERSIONS.linesPerOrder,
    unitsPerLine: Number(orderProfile.unitsPerLine) || DEFAULT_CONVERSIONS.unitsPerLine,
    weightPerUnit: Number(orderProfile.avgOrderWeight) || DEFAULT_CONVERSIONS.weightPerUnit,
    weightUnit: orderProfile.weightUnit || DEFAULT_CONVERSIONS.weightUnit,
  };

  return {
    key: 'outbound',
    name: 'Outbound',
    archetypeId: null,
    sortOrder: 10,
    primary,
    conversions,
    assumptions: { ...DEFAULT_ASSUMPTIONS },
    seasonality: {
      preset: seasonality.preset || 'flat',
      monthly_shares: Array.isArray(seasonality.monthly_shares) && seasonality.monthly_shares.length === 12
        ? seasonality.monthly_shares.slice()
        : DEFAULT_FLAT_SEASONALITY.monthly_shares.slice(),
    },
    overrides: [],
  };
}

function normalizeUom(uom) {
  const u = (uom || '').toLowerCase().trim();
  if (!u || u === 'each' || u === 'eaches' || u === 'unit') return 'units';
  if (u === 'case') return 'cases';
  if (u === 'pallet') return 'pallets';
  if (u === 'order') return 'orders';
  if (u === 'line') return 'lines';
  return u;
}

// ────────────────────────────────────────────────────────────────
// Channel accessors
// ────────────────────────────────────────────────────────────────

/**
 * Return the channels array for a model. If channels[] is populated, returns
 * it directly; otherwise synthesizes a single channel from legacy fields so
 * callers never have to branch on shape.
 *
 * @param {Object} model
 * @returns {Array<Object>}
 */
export function getChannels(model) {
  if (!model) return [];
  if (Array.isArray(model.channels) && model.channels.length > 0) {
    return model.channels;
  }
  // Legacy fallback — synthesize on every call. Phase 1.4 migration runs
  // at load time so this branch typically only hits on raw / test models.
  return [synthesizeChannelFromLegacy(model)];
}

/**
 * Look up a channel by its stable key. Returns null if not found.
 *
 * @param {Object} model
 * @param {string} channelKey
 * @returns {Object|null}
 */
export function getChannel(model, channelKey) {
  if (!channelKey) return null;
  return getChannels(model).find(c => c.key === channelKey) || null;
}

/**
 * The primary outbound channel — first non-reverse, non-hidden channel.
 * Used by single-channel-aware callers in Phase 1; Phase 3 callers should
 * usually iterate getChannels() and aggregate explicitly.
 *
 * @param {Object} model
 * @returns {Object|null}
 */
export function getPrimaryChannel(model) {
  const channels = getChannels(model);
  return channels.find(c => !c.hidden && (!c.archetypeId || c.archetypeId !== 'reverse'))
    || channels[0]
    || null;
}

/**
 * Channels representing real outbound demand (excludes reverse-logistics).
 * Reverse channel is derived from these and shouldn't double-count when
 * summing outbound activity.
 *
 * @param {Object} model
 * @returns {Array<Object>}
 */
export function getOutboundChannels(model) {
  return getChannels(model).filter(c =>
    !c.hidden &&
    c.primary &&
    c.primary.activity !== 'returns'
  );
}

// ────────────────────────────────────────────────────────────────
// Override resolution — designer-pinned values take precedence over
// pure-derived. Returns { value, isOverride, derivedValue, variancePct }.
// ────────────────────────────────────────────────────────────────

function resolveOverride(channel, key, derivedValue) {
  const override = (channel.overrides || []).find(o => o.key === key);
  if (override && Number.isFinite(Number(override.pinnedValue))) {
    const pinned = Number(override.pinnedValue);
    const variancePct = derivedValue > 0 ? ((pinned - derivedValue) / derivedValue) * 100 : 0;
    return { value: pinned, isOverride: true, derivedValue, variancePct };
  }
  return { value: derivedValue, isOverride: false, derivedValue, variancePct: 0 };
}

// ────────────────────────────────────────────────────────────────
// Per-channel derived volumes
// ────────────────────────────────────────────────────────────────

/**
 * The channel's primary annual volume, expressed in any requested UOM.
 *
 * @param {Object} channel
 * @param {string} [toUom='units']
 * @returns {number}
 */
export function getChannelPrimaryIn(channel, toUom = 'units') {
  if (!channel || !channel.primary) return 0;
  const v = Number(channel.primary.value) || 0;
  if (!v) return 0;
  return convertUom(v, normalizeUom(channel.primary.uom), normalizeUom(toUom), channel.conversions);
}

/**
 * Per-channel derived figure with override resolution.
 * Keys: 'cases' | 'pallets' | 'orders' | 'lines' | 'dailyAvg' | 'peakDay' | 'returns' | 'inbound'.
 * Returns { value, isOverride, derivedValue, variancePct }.
 *
 * @param {Object} model
 * @param {Object} channel
 * @param {string} key
 * @returns {{value: number, isOverride: boolean, derivedValue: number, variancePct: number}}
 */
export function getChannelDerived(model, channel, key) {
  if (!channel) return { value: 0, isOverride: false, derivedValue: 0, variancePct: 0 };
  const opDays = Number(model?.facility?.opDaysPerYear) || 250;
  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...(channel.assumptions || {}) };

  let derived = 0;
  switch (key) {
    case 'cases':
      derived = getChannelPrimaryIn(channel, 'cases');
      break;
    case 'pallets':
      derived = getChannelPrimaryIn(channel, 'pallets');
      break;
    case 'orders':
      derived = getChannelPrimaryIn(channel, 'orders');
      break;
    case 'lines':
      derived = getChannelPrimaryIn(channel, 'lines');
      break;
    case 'dailyAvg': {
      const annualUnits = getChannelPrimaryIn(channel, 'units');
      derived = opDays > 0 ? annualUnits / opDays : 0;
      break;
    }
    case 'peakDay': {
      const annualUnits = getChannelPrimaryIn(channel, 'units');
      const dailyAvg = opDays > 0 ? annualUnits / opDays : 0;
      derived = dailyAvg * (Number(assumptions.peakSurgeFactor) || 1);
      break;
    }
    case 'returns': {
      const annualUnits = getChannelPrimaryIn(channel, 'units');
      derived = annualUnits * ((Number(assumptions.returnsPercent) || 0) / 100);
      break;
    }
    case 'inbound': {
      const annualUnits = getChannelPrimaryIn(channel, 'units');
      derived = annualUnits * (Number(assumptions.inboundOutboundRatio) || 1);
      break;
    }
    default:
      derived = 0;
  }

  return resolveOverride(channel, key, derived);
}

// ────────────────────────────────────────────────────────────────
// Aggregate accessors — sum/aggregate across channels. Most calc
// consumers call these. Channel-specific consumers iterate getChannels()
// directly.
// ────────────────────────────────────────────────────────────────

/**
 * Total annual volume across all (non-reverse) channels in a target UOM.
 *
 * @param {Object} model
 * @param {string} [toUom='units']
 * @param {Object} [opts]
 * @param {boolean} [opts.includeReverse=false] — include reverse-logistics channel
 * @returns {number}
 */
export function getAnnualVolume(model, toUom = 'units', opts = {}) {
  const { includeReverse = false } = opts;
  const channels = includeReverse ? getChannels(model) : getOutboundChannels(model);
  return channels.reduce((sum, c) => sum + getChannelPrimaryIn(c, toUom), 0);
}

/**
 * Total derived volume for a key across all (non-reverse) channels.
 * Aggregates each channel's resolved value (override-aware).
 *
 * @param {Object} model
 * @param {string} key
 * @param {Object} [opts]
 * @param {boolean} [opts.includeReverse=false]
 * @returns {number}
 */
export function getAggregateDerived(model, key, opts = {}) {
  const { includeReverse = false } = opts;
  const channels = includeReverse ? getChannels(model) : getOutboundChannels(model);
  return channels.reduce((sum, c) => sum + getChannelDerived(model, c, key).value, 0);
}

/**
 * Total returns volume across non-reverse channels — used by reverse-logistics
 * channel auto-derive to populate its primary.
 *
 * @param {Object} model
 * @param {string} [toUom='units']
 * @returns {number}
 */
export function getTotalReturns(model, toUom = 'units') {
  const channels = getOutboundChannels(model);
  return channels.reduce((sum, c) => {
    const annualUnits = getChannelPrimaryIn(c, 'units');
    const returnsPct = Number((c.assumptions || {}).returnsPercent || 0) / 100;
    const returnsUnits = annualUnits * returnsPct;
    if (toUom === 'units') return sum + returnsUnits;
    return sum + convertUom(returnsUnits, 'units', toUom, c.conversions);
  }, 0);
}

/**
 * Total inbound volume across non-reverse channels in a target UOM.
 * Each channel's inbound = primary (units) x inboundOutboundRatio, then
 * converted to the target UOM using that channel's conversion factors.
 *
 * Used by Phase 3 calc consumers that previously read pallet-UOM
 * volumeLines directly (equipment auto-gen, racking startup capital,
 * facility-size heuristic). The legacy "annualPalletsIn" was simply
 * volumeLines.filter(v => v.uom === 'pallet').sum; the channel-aware
 * equivalent honors each channel's inbound:outbound ratio + conversions.
 *
 * @param {Object} model
 * @param {string} [toUom='units']
 * @returns {number}
 */
export function getAggregateInbound(model, toUom = 'units') {
  const channels = getOutboundChannels(model);
  return channels.reduce((sum, c) => {
    const derivedUnits = getChannelDerived(model, c, 'inbound').value;
    if (toUom === 'units') return sum + derivedUnits;
    return sum + convertUom(derivedUnits, 'units', toUom, c.conversions);
  }, 0);
}

/**
 * Channel mix (% of total annual outbound volume per channel, in units).
 * Returns [{channelKey, name, pct, annualUnits}, ...]. Excludes reverse.
 *
 * @param {Object} model
 * @returns {Array<{channelKey: string, name: string, pct: number, annualUnits: number}>}
 */
export function getChannelMix(model) {
  const channels = getOutboundChannels(model);
  const totals = channels.map(c => ({
    channelKey: c.key,
    name: c.name,
    annualUnits: getChannelPrimaryIn(c, 'units'),
  }));
  const grand = totals.reduce((s, t) => s + t.annualUnits, 0);
  return totals.map(t => ({
    ...t,
    pct: grand > 0 ? (t.annualUnits / grand) * 100 : 0,
  }));
}

/**
 * Phase 5.1 — Channels-aware provenance lineage.
 *
 * Pure summary of every channel on the model in the shape the cell-level
 * formula inspector consumes. One row per channel (including reverse +
 * hidden) so the inspector can render per-channel breakdown rows alongside
 * existing aggregate inputs. Single-channel models still get a 1-row
 * lineage; the inspector decides whether to show it based on length.
 *
 * Each row is fully derived — no mutation of the model. Numbers are pulled
 * via the existing per-channel accessors so override resolution is honored.
 *
 * @param {Object} model
 * @returns {Array<{
 *   key: string,
 *   name: string,
 *   archetypeId: string|null,
 *   isReverse: boolean,
 *   isHidden: boolean,
 *   primary: { value: number, uom: string, activity: string },
 *   primaryAsUnits: number,
 *   primaryAsOrders: number,
 *   primaryAsPallets: number,
 *   contributionPctOfTotalUnits: number,
 *   contributionPctOfOutboundUnits: number,
 *   assumptions: Object,
 *   derived: { returns: number, inbound: number, peakDay: number, dailyAvg: number },
 * }>}
 */
export function buildChannelLineage(model) {
  const channels = getChannels(model);
  if (!channels.length) return [];

  const totalUnits = getAnnualVolume(model, 'units');
  const outboundUnits = getOutboundChannels(model)
    .reduce((s, ch) => s + getChannelPrimaryIn(ch, 'units'), 0);

  return channels.map(ch => {
    const isReverse = ch.archetypeId === 'reverse'
      || (ch.primary && ch.primary.activity === 'returns');
    const primaryUnits = getChannelPrimaryIn(ch, 'units');
    const assumptions = { ...DEFAULT_ASSUMPTIONS, ...(ch.assumptions || {}) };

    return {
      key: ch.key,
      name: ch.name || ch.key,
      archetypeId: ch.archetypeId || null,
      isReverse,
      isHidden: !!ch.hidden,
      primary: {
        value: Number(ch.primary?.value) || 0,
        uom: ch.primary?.uom || 'units',
        activity: ch.primary?.activity || 'outbound',
      },
      primaryAsUnits:   primaryUnits,
      primaryAsOrders:  getChannelPrimaryIn(ch, 'orders'),
      primaryAsPallets: getChannelPrimaryIn(ch, 'pallets'),
      contributionPctOfTotalUnits:    totalUnits    > 0 ? (primaryUnits / totalUnits)    * 100 : 0,
      contributionPctOfOutboundUnits: outboundUnits > 0 && !isReverse ? (primaryUnits / outboundUnits) * 100 : 0,
      assumptions,
      derived: {
        returns:  getChannelDerived(model, ch, 'returns').value,
        inbound:  getChannelDerived(model, ch, 'inbound').value,
        peakDay:  getChannelDerived(model, ch, 'peakDay').value,
        dailyAvg: getChannelDerived(model, ch, 'dailyAvg').value,
      },
    };
  });
}

// ────────────────────────────────────────────────────────────────
// Test hook — internals exposed for unit tests only.
// ────────────────────────────────────────────────────────────────
export const _internals = {
  DEFAULT_CONVERSIONS,
  DEFAULT_ASSUMPTIONS,
  DEFAULT_FLAT_SEASONALITY,
  uomMultiplier,
  normalizeUom,
  synthesizeChannelFromLegacy,
  resolveOverride,
};
