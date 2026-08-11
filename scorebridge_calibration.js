(() => {
  'use strict';

  const admin = window.ScoreBridgeAdmin;
  if (!admin) {
    console.error('ScoreBridge calibration: chybí ScoreBridgeAdmin API.');
    return;
  }

  const { topics } = admin;
  const PROTOCOL_VERSION = 1;
  const PROFILE_SCHEMA = 'scorebridge.rf-profile';
  const PROFILE_VERSION = 1;
  const PROFILE_MAX_BYTES = 8192;
  const PROFILE_CHUNK_BYTES = 512;
  const MAX_VARIANTS = 24;
  const MAX_SIGNATURE_POINTS = 16;
  const MAX_FRAME_PAIRS = 128;
  const REQUIRED_SAMPLES = 10;
  const SAMPLE_AGREEMENT = 0.80;
  const LEARNING_TIMEOUT_SECONDS = 1200;
  const MIN_CONFIDENCE = 75;
  const SYNC = [[0, 1], [1, 1], [0, 7], [1, 1]];
  const VALID_COMMANDS = new Set(['HOME_PLUS', 'AWAY_PLUS', 'POWER_ON', 'POWER_OFF', 'START_STOP', 'ADJUST', 'TIME_ADD_TENTATIVE']);

  const steps = [
    {
      key: 'HOME_PLUS_OFF', command: 'HOME_PLUS', context: 'POWER_OFF', label: 'Domácí +1', subtitle: 'Tabule vypnuta',
      button: 'DOMÁCÍ +1', instruction: 'Nechte tabuli vypnutou a desetkrát krátce stiskněte tlačítko pro zvýšení skóre domácích.', samples: REQUIRED_SAMPLES
    },
    {
      key: 'AWAY_PLUS_OFF', command: 'AWAY_PLUS', context: 'POWER_OFF', label: 'Hosté +1', subtitle: 'Tabule vypnuta',
      button: 'HOSTÉ +1', instruction: 'Tabule zůstává vypnutá. Desetkrát krátce stiskněte tlačítko pro zvýšení skóre hostů.', samples: REQUIRED_SAMPLES
    },
    {
      key: 'POWER_TOGGLE', command: 'POWER_ON', context: 'ANY', label: 'Zapnout / vypnout', subtitle: 'Střídaná sekvence',
      button: 'ZAPNOUT', instruction: 'Střídejte zapnutí a vypnutí přesně podle pokynu. Nasbíráme deset vzorků každého stavu.', samples: REQUIRED_SAMPLES * 2,
      sequence: Array.from({ length: REQUIRED_SAMPLES * 2 }, (_, index) => index % 2 ? 'POWER_OFF' : 'POWER_ON')
    },
    {
      key: 'HOME_PLUS_ON', command: 'HOME_PLUS', context: 'POWER_ON', label: 'Domácí +1', subtitle: 'Tabule zapnuta',
      button: 'DOMÁCÍ +1', instruction: 'Zapněte tabuli a desetkrát krátce stiskněte tlačítko pro zvýšení skóre domácích.', samples: REQUIRED_SAMPLES
    },
    {
      key: 'AWAY_PLUS_ON', command: 'AWAY_PLUS', context: 'POWER_ON', label: 'Hosté +1', subtitle: 'Tabule zapnuta',
      button: 'HOSTÉ +1', instruction: 'Tabule zůstává zapnutá. Desetkrát krátce stiskněte tlačítko pro zvýšení skóre hostů.', samples: REQUIRED_SAMPLES
    },
    {
      key: 'START_STOP_ON', command: 'START_STOP', context: 'POWER_ON', label: 'Start / stop', subtitle: 'Tabule zapnuta',
      button: 'START / STOP', instruction: 'Desetkrát krátce stiskněte tlačítko START / STOP. Během měření neměňte jiné funkce.', samples: REQUIRED_SAMPLES
    },
    {
      key: 'ADJUST_ANY', command: 'ADJUST', context: 'ANY', label: 'Nastavení', subtitle: 'Volitelná funkce',
      button: 'ADJUST', instruction: 'Desetkrát krátce stiskněte tlačítko ADJUST. Pokud ho ovladačka nemá, tento krok přeskočte.', samples: REQUIRED_SAMPLES, optional: true
    },
    {
      key: 'TIME_ADD_ANY', command: 'TIME_ADD_TENTATIVE', context: 'ANY', label: '+1 minuta', subtitle: 'Předběžné mapování',
      button: '+1 MINUTA', instruction: 'Desetkrát krátce stiskněte tlačítko pro přidání minuty. Funkce je předběžná a krok lze přeskočit.', samples: REQUIRED_SAMPLES, optional: true, tentative: true
    }
  ];

  const state = {
    view: 'closed', sessionId: '', running: false, deviceReady: false, listening: false, pendingCapture: null,
    activeStep: 0, preparing: false, remeasureMode: false,
    collected: new Map(), completed: new Set(), skipped: new Set(), latestFrame: null,
    alert: '', alertTone: '', profile: null, profileName: 'Naučená ovladačka',
    upload: null, download: null, requestedDownloadId: '', factoryTransferId: '', operationTimer: null, importToken: 0,
    factoryArmed: false, profileSource: 'calibration'
  };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const html = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  };
  const makeId = prefix => {
    const raw = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${raw}`.slice(0, 36);
  };
  const truncateUtf8 = (value, maxBytes) => {
    let result = '';
    for (const character of String(value ?? '')) {
      if (encoder.encode(result + character).length > maxBytes) break;
      result += character;
    }
    return result;
  };
  const variantKey = (command, context) => `${command}|${context}`;
  const currentStep = () => steps[state.activeStep];
  const currentSequenceCommand = step => step.sequence ? step.sequence[stepSampleCount(step)] : step.command;
  const stepVariantKeys = step => step.sequence
    ? [...new Set(step.sequence.map(command => variantKey(command, 'ANY')))]
    : [variantKey(step.command, step.context)];
  const stepSampleCount = step => stepVariantKeys(step)
    .reduce((total, key) => total + (state.collected.get(key)?.samples.length || 0), 0);
  const isCalibrationView = view => typeof view === 'string' && view.startsWith('calibration');

  function normalizeFrame(input) {
    if (!Array.isArray(input) || !input.length || input.length > MAX_FRAME_PAIRS) return null;
    const frame = [];
    for (const pair of input) {
      const level = Array.isArray(pair) ? pair[0] : pair?.level;
      const units = Array.isArray(pair) ? pair[1] : pair?.units;
      if ((level !== 0 && level !== 1) || !Number.isInteger(units) || units < 1 || units > 120) return null;
      frame.push([level, units]);
    }
    return frame;
  }

  function findSyncIndex(frame) {
    for (let start = 0; start <= frame.length - SYNC.length; start += 1) {
      if (SYNC.every(([wantedLevel, wantedUnits], offset) => {
        const [level, units] = frame[start + offset];
        return level === wantedLevel && Math.abs(units - wantedUnits) <= 1;
      })) return start;
    }
    return -1;
  }

  function alignFrame(frame) {
    const start = findSyncIndex(frame);
    return start >= 0 ? frame.slice(start) : null;
  }

  function summarizeSamples(samples) {
    if (!Array.isArray(samples) || samples.length < 1 || samples.length > REQUIRED_SAMPLES) {
      return { safe: false, reason: 'Je potřeba jeden až deset platných RF vzorků.', stability: 0, confidence: 0 };
    }
    const normalized = samples.map(normalizeFrame);
    if (normalized.some(frame => !frame)) return { safe: false, reason: 'Vzorek má neplatný formát.', stability: 0, confidence: 0 };
    const aligned = normalized.map(alignFrame);
    if (aligned.some(frame => !frame)) return { safe: false, reason: 'Ve vzorku nebyl nalezen DERBY sync.', stability: 0, confidence: 0 };
    const lengths = aligned.map(frame => frame.length);
    const targetLength = median(lengths);
    const lengthTolerance = Math.max(2, Math.round(targetLength * 0.06));
    const inliers = aligned.filter(frame => Math.abs(frame.length - targetLength) <= lengthTolerance);
    const requiredInliers = Math.ceil(aligned.length * SAMPLE_AGREEMENT);
    const inlierLengths = inliers.map(frame => frame.length);
    const lengthSpread = inlierLengths.length ? Math.max(...inlierLengths) - Math.min(...inlierLengths) : 999;
    const lengthDeviations = inlierLengths.map(length => Math.abs(length - targetLength));
    const lengthScore = inlierLengths.length
      ? clamp(1 - median(lengthDeviations) / Math.max(2, targetLength * 0.05), 0, 1)
      : 0;
    const sampleAgreement = inliers.length / aligned.length;
    const commonLength = inliers.length ? Math.min(...inlierLengths) : 0;
    const candidates = [];

    for (let index = SYNC.length; index < commonLength; index += 1) {
      const ones = inliers.filter(frame => frame[index][0] === 1).length;
      const level = ones >= inliers.length - ones ? 1 : 0;
      const values = inliers.filter(frame => frame[index][0] === level).map(frame => frame[index][1]);
      if (!values.length) continue;
      const value = median(values);
      const matching = values.filter(units => Math.abs(units - value) <= 2);
      if (matching.length >= Math.ceil(inliers.length * SAMPLE_AGREEMENT)) {
        const deviations = matching.map(units => Math.abs(units - value)).sort((a, b) => a - b);
        const tolerance = clamp(deviations[Math.max(0, Math.ceil(deviations.length * SAMPLE_AGREEMENT) - 1)] || 1, 1, 2);
        candidates.push({ index, level, units: value, tolerance });
      }
    }

    const inspected = Math.max(1, commonLength - SYNC.length);
    const stability = candidates.length / inspected;
    const confidence = Math.round(100 * (0.45 * stability + 0.25 * lengthScore + 0.30 * sampleAgreement));
    const enoughInliers = inliers.length >= requiredInliers;
    const safe = enoughInliers && candidates.length >= 5 && stability >= 0.30 && confidence >= 65;
    return {
      safe,
      reason: safe ? '' : !enoughInliers
        ? `Pouze ${inliers.length} z ${aligned.length} vzorků má shodnou délku; je potřeba alespoň ${requiredInliers}.`
        : 'Alespoň 80 % vzorků nemá dostatek společných stabilních bodů.',
      aligned: inliers, allAligned: aligned, lengths, frameLength: targetLength, lengthSpread,
      lengthScore, sampleAgreement, candidates, stability, confidence
    };
  }

  function contextsOverlap(a, b) {
    return a === 'ANY' || b === 'ANY' || a === b;
  }

  function pointMatchesFrame(point, frame) {
    if (!frame || point.index >= frame.length) return false;
    const [level, units] = frame[point.index];
    return level === point.level && Math.abs(units - point.units) <= point.tolerance;
  }

  function pointMatchesSummary(point, summary) {
    const frames = summary?.aligned || [];
    if (!frames.length) return false;
    return frames.filter(frame => pointMatchesFrame(point, frame)).length >= Math.ceil(frames.length * SAMPLE_AGREEMENT);
  }

  function buildVariantAnalyses() {
    const bases = [];
    for (const entry of state.collected.values()) {
      if (entry.samples.length !== REQUIRED_SAMPLES) continue;
      const summary = summarizeSamples(entry.samples);
      bases.push({ ...entry, summary });
    }

    return bases.map(target => {
      if (!target.summary.safe) return { ...target, safe: false, confidence: target.summary.confidence, signature: [], reason: target.summary.reason };
      const competitors = bases.filter(other => other !== target && contextsOverlap(target.context, other.context));
      const uncovered = new Set(competitors.map((_, index) => index));
      const signature = [];
      const candidates = target.summary.candidates.map(point => ({
        ...point,
        covers: competitors.map((competitor, index) => pointMatchesSummary(point, competitor.summary) ? null : index).filter(index => index !== null)
      }));

      while (uncovered.size && signature.length < MAX_SIGNATURE_POINTS) {
        const best = candidates
          .filter(candidate => !signature.includes(candidate))
          .map(candidate => ({ candidate, gain: candidate.covers.filter(index => uncovered.has(index)).length }))
          .sort((a, b) => b.gain - a.gain || a.candidate.index - b.candidate.index)[0];
        if (!best || best.gain === 0) break;
        signature.push(best.candidate);
        best.candidate.covers.forEach(index => uncovered.delete(index));
      }

      for (const candidate of candidates) {
        if (signature.length >= 3 || signature.length >= MAX_SIGNATURE_POINTS) break;
        if (!signature.includes(candidate)) signature.push(candidate);
      }

      const uniqueness = competitors.length ? 1 - uncovered.size / competitors.length : 1;
      const signatureScore = clamp(signature.length / 4, 0, 1);
      const confidence = Math.round(100 * (
        0.30 * target.summary.stability +
        0.20 * target.summary.lengthScore +
        0.35 * uniqueness +
        0.15 * signatureScore
      ));
      const safe = uncovered.size === 0 && signature.length >= 3 && confidence >= MIN_CONFIDENCE;
      return {
        ...target, safe, confidence,
        signature: signature.map(({ covers, ...point }) => point),
        reason: safe ? '' : uncovered.size ? 'Podpis koliduje s jiným příkazem.' : 'Confidence je příliš nízká.'
      };
    });
  }

  function buildProfile() {
    const analyses = buildVariantAnalyses();
    const grouped = new Map();
    analyses.forEach(analysis => {
      if (!grouped.has(analysis.command)) grouped.set(analysis.command, []);
      grouped.get(analysis.command).push({
        context: analysis.context,
        frame_length: analysis.summary.frameLength || 0,
        frame_tolerance: 2,
        confidence: analysis.confidence,
        safe: analysis.safe,
        signature: analysis.signature
      });
    });
    return {
      schema: PROFILE_SCHEMA,
      version: PROFILE_VERSION,
      profile_id: makeId('rf'),
      name: truncateUtf8(state.profileName, 32),
      created_at: new Date().toISOString(),
      rf: {
        frequency_mhz: 433.87,
        modulation: 'ASK/OOK',
        rx_bandwidth_khz: 270.83,
        base_time_us: 830,
        sync: SYNC.map(pair => [...pair]),
        sync_tolerance: 1
      },
      decoder: {
        max_frame_pairs: MAX_FRAME_PAIRS,
        context_precedence: ['CURRENT', 'ANY'],
        minimum_confidence: MIN_CONFIDENCE
      },
      commands: [...grouped.entries()].map(([command, variants]) => ({ command, variants })),
      calibration: {
        samples_per_variant: REQUIRED_SAMPLES,
        algorithm: 'robust-80pct-greedy-unique-v2',
        skipped_steps: [...state.skipped]
      },
      analysis: analyses.map(item => ({
        command: item.command, context: item.context, source_step: item.sourceStep,
        confidence: item.confidence, safe: item.safe, reason: item.reason
      }))
    };
  }

  function validateProfile(profile) {
    if (!isRecord(profile) || profile.schema !== PROFILE_SCHEMA || profile.version !== PROFILE_VERSION) return 'Soubor nemá podporovaný formát ScoreBridge RF profilu.';
    if (typeof profile.profile_id !== 'string' || !/^[\x21-\x7e]{1,36}$/.test(profile.profile_id)) return 'Neplatné ID profilu.';
    if (typeof profile.name !== 'string' || !profile.name || encoder.encode(profile.name).length > 32) return 'Neplatný název profilu (maximum je 32 UTF-8 bajtů).';
    if (!isRecord(profile.rf) || profile.rf.frequency_mhz !== 433.87 || profile.rf.modulation !== 'ASK/OOK' ||
        profile.rf.rx_bandwidth_khz !== 270.83 || profile.rf.base_time_us !== 830 ||
        !Array.isArray(profile.rf.sync) || profile.rf.sync.length !== 4 ||
        !profile.rf.sync.every((pair, index) => Array.isArray(pair) && pair[0] === SYNC[index][0] && pair[1] === SYNC[index][1]) ||
        !Number.isInteger(profile.rf.sync_tolerance) || profile.rf.sync_tolerance !== 1) return 'Profil obsahuje neplatné RF parametry.';
    if (!isRecord(profile.decoder) || profile.decoder.max_frame_pairs !== MAX_FRAME_PAIRS ||
        profile.decoder.minimum_confidence !== MIN_CONFIDENCE || !Array.isArray(profile.decoder.context_precedence) ||
        profile.decoder.context_precedence.join('|') !== 'CURRENT|ANY') return 'Profil obsahuje neplatné nastavení dekodéru.';
    if (!Array.isArray(profile.commands) || !profile.commands.length) return 'Profil neobsahuje žádné příkazy.';
    if (profile.commands.some(item => !isRecord(item) || !VALID_COMMANDS.has(item.command) || !Array.isArray(item.variants) || !item.variants.length)) return 'Profil obsahuje neplatný příkaz nebo pole variant.';
    const commandNames = profile.commands.map(item => item.command);
    if (new Set(commandNames).size !== commandNames.length) return 'Profil obsahuje duplicitní skupinu příkazu.';
    const variants = profile.commands.flatMap(command => command.variants);
    if (!variants.length || variants.length > MAX_VARIANTS) return 'Profil má neplatný počet variant.';
    const variantIds = new Set();
    for (const command of profile.commands) {
      for (const variant of command.variants) {
        if (!isRecord(variant)) return 'Profil obsahuje neplatnou variantu.';
        const id = `${command.command}|${variant.context}`;
        if (variantIds.has(id)) return 'Profil obsahuje duplicitní variantu příkazu.';
        variantIds.add(id);
      }
    }
    for (const variant of variants) {
      if (!['POWER_ON', 'POWER_OFF', 'ANY'].includes(variant.context)) return 'Profil obsahuje neplatný kontext.';
      if (!Number.isInteger(variant.frame_length) || variant.frame_length < 4 || variant.frame_length > MAX_FRAME_PAIRS) return 'Profil obsahuje neplatnou délku frame.';
      if (!Number.isInteger(variant.frame_tolerance) || variant.frame_tolerance < 0 || variant.frame_tolerance > 4) return 'Profil obsahuje neplatnou toleranci délky.';
      if (!Number.isInteger(variant.confidence) || variant.confidence < 0 || variant.confidence > 100 || typeof variant.safe !== 'boolean') return 'Profil obsahuje neplatné vyhodnocení confidence.';
      if (!Array.isArray(variant.signature) || variant.signature.length < 1 || variant.signature.length > MAX_SIGNATURE_POINTS) return 'Profil obsahuje neplatný podpis.';
      const pointIndices = new Set();
      for (const point of variant.signature) {
        if (!isRecord(point) || !Number.isInteger(point.index) || point.index < 0 || point.index >= variant.frame_length ||
            ![0, 1].includes(point.level) || !Number.isInteger(point.units) || point.units < 1 || point.units > 120 ||
            !Number.isInteger(point.tolerance) || point.tolerance < 0 || point.tolerance > 3) return 'Profil obsahuje neplatný bod podpisu.';
        if (pointIndices.has(point.index)) return 'Profil obsahuje duplicitní index bodu podpisu.';
        pointIndices.add(point.index);
      }
    }
    let bytes;
    try { bytes = encoder.encode(JSON.stringify(profile)); } catch { return 'Profil nelze serializovat do JSON.'; }
    return bytes.length > PROFILE_MAX_BYTES ? `Profil je příliš velký (${bytes.length} B).` : '';
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function parseJsonMessage(message) {
    try { return JSON.parse(message.toString()); } catch { return null; }
  }

  function clearOperationTimeout() {
    if (state.operationTimer) clearTimeout(state.operationTimer);
    state.operationTimer = null;
  }

  function armOperationTimeout(milliseconds, callback) {
    clearOperationTimeout();
    state.operationTimer = setTimeout(() => {
      state.operationTimer = null;
      callback();
    }, milliseconds);
  }

  function connectionBadge() {
    return `<span class="cal-connection ${admin.isConnected() ? 'connected' : ''}">${admin.isConnected() ? 'zařízení připojeno' : 'zařízení odpojeno'}</span>`;
  }

  function setActiveNavigation() {
    document.querySelectorAll('.side-link').forEach(link => link.classList.toggle('active', link.hasAttribute('data-calibration-open')));
  }

  function landingBody() {
    const confirmation = state.factoryArmed ? `
      <div class="cal-alert error">Tovární profil nahradí aktivní naučený profil v zařízení. Tuto změnu potvrďte ještě jednou.</div>
      <button class="cal-primary-action" data-calibration-action="confirm-factory" ${admin.isConnected() ? '' : 'disabled'}>Ano, obnovit tovární profil</button>` : '';
    const notice = state.alert ? `<div class="cal-alert ${html(state.alertTone)}">${html(state.alert)}</div>` : '';
    return `
      <div class="cal-landing">
        <section class="cal-landing-hero">
          <div class="cal-landing-mark">⌾</div>
          <span class="cal-kicker">ScoreBridge RF learning</span>
          <h3>Naučte zařízení novou ovladačku.</h3>
          <p>Průvodce změří rádiové podpisy tlačítek, porovná je mezi sebou a vytvoří bezpečný profil bez rekompilace firmware.</p>
        </section>
        <section class="cal-landing-panel">
          <div class="cal-topline" style="margin-bottom:0">
            <div><span class="cal-kicker">Kalibrace ovladačky</span><h3 style="font-size:27px;letter-spacing:-1px">Připraveno k měření</h3></div>
            ${connectionBadge()}
          </div>
          <div class="cal-feature-list">
            <div class="cal-feature"><i>10×</i><div><strong>Deset vzorků každého tlačítka</strong><span>Robustní 80% shoda odfiltruje jednotlivé nepovedené stisky.</span></div></div>
            <div class="cal-feature"><i>⌁</i><div><strong>Deterministický unikátní podpis</strong><span>Profil používá jen stabilní pozice odlišné od ostatních příkazů.</span></div></div>
            <div class="cal-feature"><i>✓</i><div><strong>Bezpečné uložení do zařízení</strong><span>Chunky, pořadí a CRC32 se ověří před zápisem do NVS.</span></div></div>
          </div>
          ${notice}${confirmation}
          ${state.factoryArmed ? '' : `<button class="cal-primary-action" data-calibration-action="start" ${admin.isConnected() ? '' : 'disabled'}>Naučit novou ovladačku</button>`}
          <div class="cal-secondary-actions">
            <button data-calibration-action="load-profile" ${admin.isConnected() ? '' : 'disabled'}>Načíst profil ze zařízení</button>
            <button data-calibration-action="import-profile">Importovat JSON</button>
            <button data-calibration-action="arm-factory" ${admin.isConnected() ? '' : 'disabled'}>Obnovit tovární profil</button>
            <button data-calibration-action="documentation">Jak kalibrace funguje</button>
          </div>
          <input class="cal-hidden-input" id="calProfileImport" type="file" accept="application/json,.json">
        </section>
      </div>`;
  }

  function openLanding(message = '', tone = '') {
    document.getElementById('appModal')?.classList.add('calibration-modal');
    state.view = 'landing';
    state.alert = message;
    state.alertTone = tone;
    state.factoryArmed = false;
    admin.setModalView('calibration-landing');
    setActiveNavigation();
    admin.showModal({
      eyebrow: 'RF learning / správa profilů', title: 'Kalibrace ovladačky', fullscreen: true,
      body: landingBody(), footer: '<button data-calibration-action="close">Zavřít</button>'
    });
  }

  function renderLanding() {
    if (state.view !== 'landing') return;
    document.getElementById('appModalBody').innerHTML = landingBody();
  }

  function stepStatusClass(step, index) {
    if (state.skipped.has(step.key)) return 'skipped';
    if (state.completed.has(step.key)) return 'done';
    return index === state.activeStep ? 'active' : '';
  }

  function stepListHtml() {
    return steps.map((step, index) => {
      const css = stepStatusClass(step, index);
      const status = css === 'done' ? '✓' : css === 'skipped' ? '–' : index === state.activeStep ? `${stepSampleCount(step)}/${step.samples}` : '';
      return `<div class="cal-step-item ${css}">
        <span class="cal-step-number">${css === 'done' ? '✓' : index + 1}</span>
        <span class="cal-step-copy"><strong>${html(step.label)}</strong><span>${html(step.subtitle)}</span></span>
        <span class="cal-step-state">${status}</span>
      </div>`;
    }).join('');
  }

  function pulsePreview(frame) {
    if (!frame?.length) return '<span class="cal-pulse-empty">ČEKÁM NA PRVNÍ RF VZOREK</span>';
    const visible = frame.slice(0, 68);
    return visible.map(([level, units]) => `<i class="${level ? 'high' : ''}" style="height:${level ? 42 : 17}px;flex:${clamp(units, 1, 10)}"></i>`).join('');
  }

  function currentStepSummary(step) {
    const summaries = stepVariantKeys(step)
      .map(key => state.collected.get(key)?.samples || [])
      .filter(samples => samples.length)
      .map(samples => summarizeSamples(samples));
    if (!summaries.length) return { stability: 0, confidence: 0, frameLength: 0, stablePositions: 0, safe: false };
    return {
      stability: summaries.reduce((sum, item) => sum + (item.stability || 0), 0) / summaries.length,
      confidence: Math.round(summaries.reduce((sum, item) => sum + (item.confidence || 0), 0) / summaries.length),
      frameLength: summaries[summaries.length - 1].frameLength || state.latestFrame?.length || 0,
      stablePositions: Math.min(...summaries.map(item => item.candidates?.length || 0)),
      safe: summaries.every(item => item.safe)
    };
  }

  function expectedInstruction(step) {
    const command = currentSequenceCommand(step) || step.command;
    if (step.sequence) return command === 'POWER_ON'
      ? 'Nyní stiskněte ZAPNOUT a počkejte na zachycení vzorku.'
      : 'Nyní stiskněte VYPNOUT a počkejte na zachycení vzorku.';
    return step.instruction;
  }

  function contextLabel(step) {
    if (step.sequence) return (currentSequenceCommand(step) || 'POWER_ON') === 'POWER_ON' ? 'Zapnout tabuli' : 'Vypnout tabuli';
    return step.context === 'POWER_ON' ? 'Tabule zapnuta' : step.context === 'POWER_OFF' ? 'Tabule vypnuta' : 'Libovolný stav';
  }

  function contextClass(step) {
    if (step.sequence) return (currentSequenceCommand(step) || 'POWER_ON') === 'POWER_ON' ? 'power-on' : 'power-off';
    return step.context === 'POWER_ON' ? 'power-on' : step.context === 'POWER_OFF' ? 'power-off' : '';
  }

  function wizardBody() {
    const step = currentStep();
    const count = stepSampleCount(step);
    const summary = currentStepSummary(step);
    const progress = Math.round(100 * count / step.samples);
    const powerCounts = step.sequence ? `<div class="cal-power-counts"><span>POWER ON <b>${state.collected.get(variantKey('POWER_ON', 'ANY'))?.samples.length || 0}/${REQUIRED_SAMPLES}</b></span><span>POWER OFF <b>${state.collected.get(variantKey('POWER_OFF', 'ANY'))?.samples.length || 0}/${REQUIRED_SAMPLES}</b></span></div>` : '';
    const alert = state.alert ? `<div class="cal-alert ${html(state.alertTone)}">${html(state.alert)}</div>` : '';
    return `
      <div class="calibration-wizard">
        <aside class="cal-sidebar">
          <div class="cal-sidebar-brand"><div class="cal-sidebar-mark">⌾</div><div><span>RF learning</span><strong>Kalibrace ovladačky</strong></div></div>
          <div class="cal-step-list">${stepListHtml()}</div>
          <div class="cal-session">ID relace<b>${html(state.sessionId)}</b></div>
        </aside>
        <main class="cal-main">
          <div class="cal-topline">
            <div><span class="cal-kicker">Krok ${state.activeStep + 1} z ${steps.length} · ${html(step.subtitle)}</span><h3>${html(step.label)}</h3><p class="cal-lead">${html(expectedInstruction(step))}</p></div>
            <div class="cal-top-status">
              <div class="cal-progress-hero">
                <div><span>Průběh kroku</span><strong>${progress}%</strong><small>${count} z ${step.samples} stisků</small></div>
                <i><b style="width:${progress}%"></b></i>
              </div>
              ${connectionBadge()}
            </div>
          </div>
          <div class="cal-work-grid">
            <section class="cal-card cal-instruction">
              <div class="cal-instruction-head"><span class="cal-context ${contextClass(step)}">${html(contextLabel(step))}</span><span class="cal-sample-count">${count} / ${step.samples}</span></div>
              ${powerCounts}
              <div class="cal-button-visual ${state.listening && count < step.samples ? 'waiting' : ''}">${html(step.sequence ? (currentSequenceCommand(step) === 'POWER_OFF' ? 'VYPNOUT' : 'ZAPNOUT') : step.button)}</div>
              <p class="cal-instruction-text">Použijte <b>fyzickou ovladačku DERBY</b>. ScoreBridge během learning režimu žádný přijatý příkaz neaplikuje na skóre.</p>
              <div class="cal-capture ${state.listening ? 'listening' : ''}"><i></i>${state.listening ? 'Přijímač čeká na stisk' : state.deviceReady ? 'Připravuji další vzorek' : 'Čekám na potvrzení zařízení'}</div>
            </section>
            <section class="cal-card cal-diagnostics">
              <h4>Poslední normalizovaný frame</h4>
              <div class="cal-pulse-preview">${pulsePreview(state.latestFrame)}</div>
              <div class="cal-diag-grid">
                <div class="cal-diag"><span>Délka</span><strong>${summary.frameLength || '–'}</strong></div>
                <div class="cal-diag"><span>Stabilita</span><strong>${summary.stability ? Math.round(summary.stability * 100) + '%' : '–'}</strong></div>
                <div class="cal-diag"><span>Confidence</span><strong>${summary.confidence ? summary.confidence + '%' : '–'}</strong></div>
                <div class="cal-diag"><span>Sync</span><strong>${state.latestFrame ? (findSyncIndex(state.latestFrame) >= 0 ? 'OK' : 'CHYBÍ') : '–'}</strong></div>
                <div class="cal-diag"><span>Stabilní body</span><strong>${summary.stablePositions || '–'}</strong></div>
              </div>
            </section>
          </div>
          <section class="cal-card cal-progress-wrap cal-progress-bottom">
            <div class="cal-progress-head"><strong>Celkový průběh tohoto kroku</strong><span>${count} / ${step.samples} · ${progress}%</span></div>
            <div class="cal-progress"><i style="width:${progress}%"></i></div>
          </section>
          ${alert}
        </main>
      </div>`;
  }

  function wizardFooter() {
    const step = currentStep();
    const complete = state.completed.has(step.key);
    return `
      <button class="cal-footer-cancel" data-calibration-action="cancel">Zrušit kalibraci</button>
      <button class="cal-footer-retry" data-calibration-action="retry" ${state.running && state.deviceReady && admin.isConnected() ? '' : 'disabled'}>Zopakovat krok</button>
      ${step.optional ? '<button class="cal-footer-skip" data-calibration-action="skip">Přeskočit volitelnou funkci</button>' : ''}
      <button class="modal-confirm cal-footer-next" data-calibration-action="next" ${complete ? '' : 'disabled'}>${state.activeStep === steps.length - 1 ? 'Vyhodnotit profil' : 'Pokračovat'}</button>`;
  }

  function renderWizard() {
    if (state.view !== 'wizard') return;
    admin.setModalView('calibration-wizard');
    const modal = document.getElementById('appModal');
    if (!modal.classList.contains('open')) {
      admin.showModal({ eyebrow: 'RF learning / živé měření', title: 'Kalibrace ovladačky', fullscreen: true, body: wizardBody(), footer: wizardFooter() });
      return;
    }
    document.getElementById('appModalEyebrow').textContent = 'RF learning / živé měření';
    document.getElementById('appModalTitle').textContent = 'Kalibrace ovladačky';
    document.getElementById('appModalBody').innerHTML = wizardBody();
    const footer = document.getElementById('appModalFooter');
    footer.innerHTML = wizardFooter();
    footer.hidden = false;
  }

  function showPowerPreparation() {
    state.preparing = true;
    state.listening = false;
    state.pendingCapture = null;
    state.alert = '';
    admin.setModalView('calibration-wizard');
    const body = `
      <div class="calibration-wizard">
        <aside class="cal-sidebar">
          <div class="cal-sidebar-brand"><div class="cal-sidebar-mark">⌾</div><div><span>RF learning</span><strong>Kalibrace ovladačky</strong></div></div>
          <div class="cal-step-list">${stepListHtml()}</div>
          <div class="cal-session">ID relace<b>${html(state.sessionId)}</b></div>
        </aside>
        <main class="cal-main">
          <div class="cal-topline"><div><span class="cal-kicker">Příprava zapnutého kontextu</span><h3>Zapněte tabuli.</h3><p class="cal-lead">Sekvence POWER skončila ve vypnutém stavu. Jednou stiskněte ZAPNOUT. Tento přechod se do dalšího tlačítka nezapočítá.</p></div>${connectionBadge()}</div>
          <section class="cal-card cal-instruction" style="display:grid;place-items:center;min-height:390px">
            <div><div class="cal-button-visual">ZAPNOUT</div><p class="cal-instruction-text">Až se tabule skutečně rozsvítí, potvrďte stav tlačítkem dole. Teprve potom se přijímač připraví na <b>DOMÁCÍ +1</b>.</p></div>
          </section>
        </main>
      </div>`;
    const footer = '<button data-calibration-action="cancel">Zrušit kalibraci</button><button class="modal-confirm" data-calibration-action="prepared">Tabule je zapnutá</button>';
    document.getElementById('appModalBody').innerHTML = body;
    const footerElement = document.getElementById('appModalFooter');
    footerElement.innerHTML = footer;
    footerElement.hidden = false;
  }

  function flatProfileVariants(profile) {
    return (profile?.commands || []).flatMap(command => (command.variants || []).map(variant => ({ command: command.command, ...variant })));
  }

  function overallProfileConfidence(profile) {
    const variants = flatProfileVariants(profile);
    return variants.length ? Math.round(variants.reduce((sum, item) => sum + (Number(item.confidence) || 0), 0) / variants.length) : 0;
  }

  function profileIsSafe(profile) {
    const variants = flatProfileVariants(profile);
    return variants.length > 0 && variants.every(variant => variant.safe !== false && (Number(variant.confidence) || 0) >= MIN_CONFIDENCE);
  }

  function scoreClass(confidence, safe = true) {
    return !safe || confidence < MIN_CONFIDENCE ? 'cal-score-bad' : confidence < 85 ? 'cal-score-warn' : 'cal-score-good';
  }

  function sourceStepIndex(command, context) {
    return steps.findIndex(step => step.sequence
      ? step.sequence.includes(command)
      : step.command === command && step.context === context);
  }

  function summaryBody() {
    const profile = state.profile;
    const variants = flatProfileVariants(profile);
    const confidence = overallProfileConfidence(profile);
    const safe = profileIsSafe(profile);
    const size = encoder.encode(JSON.stringify(profile)).length;
    const rows = variants.map(variant => {
      const variantSafe = variant.safe !== false && (variant.confidence || 0) >= MIN_CONFIDENCE;
      const index = sourceStepIndex(variant.command, variant.context);
      const canRemeasure = !state.upload && state.profileSource === 'calibration' && state.collected.size > 0 && index >= 0;
      return `<div class="cal-command-row">
        <div><b>${html(variant.command)}</b>${variantSafe ? '' : `<small class="cal-row-reason">${html(variant.reason || 'Podpis není bezpečně jedinečný.')}</small>`}${variantSafe || !canRemeasure ? '' : `<br><button data-calibration-action="remeasure" data-step-index="${index}">Změřit znovu</button>`}</div>
        <span>${html(variant.context)}</span>
        <span>${variant.signature?.length || 0} bodů</span>
        <span class="${scoreClass(variant.confidence || 0, variantSafe)}">${variant.confidence || 0}%</span>
      </div>`;
    }).join('');
    const notice = state.alert ? `<div class="cal-alert ${html(state.alertTone)}">${html(state.alert)}</div>` : '';
    return `
      <div class="cal-complete">
        <div class="cal-complete-head">
          <div><span class="cal-kicker">Výsledek deterministické analýzy</span><h3>${safe ? 'Profil je připraven.' : 'Profil vyžaduje nové měření.'}</h3><p class="cal-lead">Podpisy byly přepočítány proti všem nasbíraným příkazům v překrývajících se kontextech.</p></div>
          ${connectionBadge()}
        </div>
        <div class="cal-profile-summary">
          <div class="cal-profile-card"><span>Varianty příkazů</span><strong>${variants.length}</strong></div>
          <div class="cal-profile-card"><span>Celkové confidence</span><strong class="${scoreClass(confidence, safe)}">${confidence}%</strong></div>
          <div class="cal-profile-card"><span>Velikost JSON</span><strong>${size} B</strong></div>
        </div>
        <label class="cal-card" style="display:block;margin-top:14px;padding:15px">
          <span class="cal-section-label">Název profilu</span>
          <input id="calProfileName" value="${html(profile.name)}" maxlength="32" ${state.upload ? 'disabled' : ''} style="width:100%;height:43px;margin-top:9px;padding:0 12px;border:1px solid #d9d9d3;border-radius:9px;background:#fff;font:700 12px inherit">
        </label>
        <div class="cal-command-table">
          <div class="cal-command-row header"><span>Příkaz</span><span>Kontext</span><span>Podpis</span><span>Confidence</span></div>
          ${rows}
        </div>
        ${safe ? '<div class="cal-alert success">Všechny varianty mají unikátní podpis a splňují minimální confidence 75 %.</div>' : '<div class="cal-alert error">Nejasné varianty nelze uložit. Použijte „Změřit znovu“ u červeně označeného příkazu.</div>'}
        ${notice}
      </div>`;
  }

  function summaryFooter() {
    const safe = profileIsSafe(state.profile) && !validateProfile(state.profile);
    const busy = Boolean(state.upload);
    return `
      <button data-calibration-action="close">Zavřít</button>
      <button data-calibration-action="export-profile">Exportovat JSON</button>
      <button data-calibration-action="start-over" ${busy ? 'disabled' : ''}>Nová kalibrace</button>
      <button class="modal-confirm" data-calibration-action="save-profile" ${safe && admin.isConnected() && !busy ? '' : 'disabled'}>${busy ? 'Ukládám…' : 'Uložit profil do zařízení'}</button>`;
  }

  function showSummary(profile = state.profile, source = state.profileSource) {
    if (state.running) stopLearning('summary_opened');
    state.running = false;
    state.listening = false;
    state.deviceReady = false;
    state.profile = profile;
    state.profileSource = source;
    state.view = 'summary';
    admin.setModalView('calibration-summary');
    admin.showModal({
      eyebrow: source === 'device' ? 'RF profil / aktivní zařízení' : 'RF learning / dokončeno',
      title: source === 'device' ? 'Aktivní RF profil' : 'Výsledek kalibrace', fullscreen: true,
      body: summaryBody(), footer: summaryFooter()
    });
  }

  function renderSummary() {
    if (state.view !== 'summary' || !state.profile) return;
    document.getElementById('appModalBody').innerHTML = summaryBody();
    const footer = document.getElementById('appModalFooter');
    footer.innerHTML = summaryFooter();
    footer.hidden = false;
  }

  function showLoading(title, message) {
    state.view = 'loading';
    admin.setModalView('calibration-loading');
    admin.showModal({
      eyebrow: 'RF profil / zařízení', title, fullscreen: true,
      body: `<div class="cal-loading"><div>${html(message)}</div></div>`,
      footer: '<button data-calibration-action="close">Zavřít</button>'
    });
  }

  function publishLearn(type, extra = {}) {
    return admin.publishJson(topics.learnCommand, { v: PROTOCOL_VERSION, type, session_id: state.sessionId, ...extra });
  }

  function expectedCommandForStep(step) {
    return step.sequence ? currentSequenceCommand(step) : step.command;
  }

  function armCurrentStep() {
    const step = currentStep();
    const command = expectedCommandForStep(step);
    if (!command) return;
    state.listening = false;
    const sampleIndex = stepSampleCount(step) + 1;
    state.pendingCapture = {
      step: step.key, command,
      context: step.sequence ? 'ANY' : step.context,
      sampleIndex
    };
    publishLearn('set_step', {
      step: state.pendingCapture.step, command: state.pendingCapture.command,
      context: state.pendingCapture.context,
      sample_index: sampleIndex
    });
    armOperationTimeout(10000, () => {
      if (!state.running || state.listening) return;
      state.alert = 'Zařízení nepotvrdilo připravenost kroku. Zkontrolujte spojení a použijte „Zopakovat krok“.';
      state.alertTone = 'error';
      renderWizard();
    });
    renderWizard();
  }

  function beginCalibration() {
    if (state.upload) return;
    if (!admin.isConnected()) return openLanding('Zařízení není připojeno. Kalibraci nelze zahájit.', 'error');
    state.importToken += 1;
    state.sessionId = makeId('learn');
    state.running = true;
    state.deviceReady = false;
    state.listening = false;
    state.pendingCapture = null;
    state.activeStep = 0;
    state.preparing = false;
    state.remeasureMode = false;
    state.collected = new Map();
    state.completed = new Set();
    state.skipped = new Set();
    state.latestFrame = null;
    state.profile = null;
    state.profileName = 'Naučená ovladačka';
    state.alert = 'Navazuji learning relaci se zařízením…';
    state.alertTone = '';
    state.view = 'wizard';
    admin.setModalView('calibration-wizard');
    admin.showModal({ eyebrow: 'RF learning / živé měření', title: 'Kalibrace ovladačky', fullscreen: true, body: wizardBody(), footer: wizardFooter() });
    publishLearn('start', { timeout_s: LEARNING_TIMEOUT_SECONDS, base_time_us: 830, max_frame_pairs: MAX_FRAME_PAIRS });
    armOperationTimeout(12000, () => {
      if (!state.running || state.deviceReady) return;
      state.alert = 'Zařízení nepotvrdilo spuštění learning režimu. Kalibraci můžete zrušit a spustit znovu.';
      state.alertTone = 'error';
      renderWizard();
    });
    admin.log(`Kalibrace: start relace ${state.sessionId}`);
  }

  function stopLearning(reason = 'user_cancelled') {
    if (!state.running || !state.sessionId) return;
    publishLearn('stop', { reason });
    state.sessionId = '';
    state.running = false;
    state.listening = false;
    state.deviceReady = false;
    state.pendingCapture = null;
    clearOperationTimeout();
    admin.log(`Kalibrace: stop (${reason})`);
  }

  function retryStep() {
    const step = currentStep();
    stepVariantKeys(step).forEach(key => state.collected.delete(key));
    state.completed.delete(step.key);
    state.skipped.delete(step.key);
    state.latestFrame = null;
    state.alert = 'Předchozí vzorky kroku byly odstraněny. Začněte znovu.';
    state.alertTone = '';
    publishLearn('retry_step', { step: step.key });
    armCurrentStep();
  }

  function skipStep() {
    const step = currentStep();
    if (!step.optional) return;
    stepVariantKeys(step).forEach(key => state.collected.delete(key));
    state.skipped.add(step.key);
    state.completed.delete(step.key);
    advanceStep();
  }

  function advanceStep() {
    if (state.remeasureMode) {
      stopLearning('remeasure_complete');
      state.remeasureMode = false;
      state.profile = buildProfile();
      state.alert = '';
      state.alertTone = '';
      showSummary(state.profile, 'calibration');
      return;
    }
    if (currentStep().key === 'POWER_TOGGLE' && !state.preparing) {
      showPowerPreparation();
      return;
    }
    if (state.activeStep < steps.length - 1) {
      state.preparing = false;
      state.activeStep += 1;
      state.alert = '';
      state.alertTone = '';
      state.latestFrame = null;
      armCurrentStep();
      return;
    }
    stopLearning('calibration_complete');
    state.profile = buildProfile();
    state.alert = '';
    state.alertTone = '';
    showSummary(state.profile, 'calibration');
  }

  function remeasureStep(index) {
    if (!Number.isInteger(index) || index < 0 || index >= steps.length) return;
    if (!admin.isConnected()) {
      state.alert = 'Zařízení není připojeno. Nové měření nelze zahájit.';
      state.alertTone = 'error';
      return renderSummary();
    }
    const step = steps[index];
    stepVariantKeys(step).forEach(key => state.collected.delete(key));
    state.completed.delete(step.key);
    state.skipped.delete(step.key);
    state.activeStep = index;
    state.preparing = false;
    state.remeasureMode = true;
    state.sessionId = makeId('learn');
    state.running = true;
    state.deviceReady = false;
    state.listening = false;
    state.pendingCapture = null;
    state.latestFrame = null;
    state.alert = 'Navazuji novou relaci pro opakované měření…';
    state.alertTone = '';
    state.view = 'wizard';
    admin.setModalView('calibration-wizard');
    renderWizard();
    publishLearn('start', { timeout_s: LEARNING_TIMEOUT_SECONDS, base_time_us: 830, max_frame_pairs: MAX_FRAME_PAIRS });
    armOperationTimeout(12000, () => {
      if (!state.running || state.deviceReady) return;
      state.alert = 'Zařízení nepotvrdilo novou learning relaci.';
      state.alertTone = 'error';
      renderWizard();
    });
  }

  function storeSample(step, command, frame) {
    const context = step.sequence ? 'ANY' : step.context;
    const key = variantKey(command, context);
    if (!state.collected.has(key)) state.collected.set(key, { command, context, sourceStep: step.key, samples: [] });
    const entry = state.collected.get(key);
    if (entry.samples.length >= REQUIRED_SAMPLES) return false;
    entry.samples.push(frame);
    return true;
  }

  function processLearningSample(data) {
    const pending = state.pendingCapture;
    if (!state.running || !pending || data?.v !== PROTOCOL_VERSION || data?.session_id !== state.sessionId || data?.type !== 'sample') return;
    const step = currentStep();
    if (!state.listening || data.step !== pending.step || data.command !== pending.command ||
        data.context !== pending.context || data.sample_index !== pending.sampleIndex) return;
    const expectedCommand = expectedCommandForStep(step);
    if (data.command !== expectedCommand) return;
    if (data.overflow) {
      state.alert = 'RF buffer přetekl. Stiskněte tlačítko znovu.';
      state.alertTone = 'error';
      state.listening = false;
      armCurrentStep();
      return;
    }
    const frame = normalizeFrame(data.frame);
    if (!frame || findSyncIndex(frame) < 0) {
      state.alert = 'Vzorek je neplatný nebo neobsahuje DERBY sync. Zkuste stisk znovu.';
      state.alertTone = 'error';
      state.listening = false;
      armCurrentStep();
      return;
    }
    if (!storeSample(step, expectedCommand, frame)) return;
    state.pendingCapture = null;
    state.latestFrame = frame;
    window.dispatchEvent(new CustomEvent('scorebridge:rf-frame', { detail: {
      frame, command: expectedCommand, context: data.context, sampleIndex: data.sample_index
    }}));
    state.listening = false;
    state.alert = `Vzorek ${stepSampleCount(step)} z ${step.samples} byl přijat.`;
    state.alertTone = 'success';
    admin.log(`Kalibrace: ${step.key} vzorek ${stepSampleCount(step)}/${step.samples}, ${frame.length} pulzů`);

    if (stepSampleCount(step) >= step.samples) {
      const summaries = stepVariantKeys(step).map(key => summarizeSamples(state.collected.get(key)?.samples || []));
      if (summaries.every(summary => summary.safe)) {
        state.completed.add(step.key);
        state.alert = 'Krok je stabilní. Můžete pokračovat.';
        state.alertTone = 'success';
      } else {
        state.completed.delete(step.key);
        state.alert = summaries.find(summary => !summary.safe)?.reason || 'Měření není dostatečně stabilní. Zopakujte krok.';
        state.alertTone = 'error';
      }
      renderWizard();
      return;
    }
    armCurrentStep();
  }

  function handleLearningStatus(data) {
    if (!state.running || !data || data.v !== PROTOCOL_VERSION || data.session_id !== state.sessionId) return;
    if (data.type === 'started') {
      if (data.mode !== 'LEARNING_MODE') return;
      clearOperationTimeout();
      state.deviceReady = true;
      if (state.preparing) {
        state.alert = '';
        showPowerPreparation();
        return;
      }
      if (state.completed.has(currentStep()?.key)) {
        state.listening = false;
        state.alert = 'Learning relace je obnovena. Dokončený krok zůstal zachován; můžete pokračovat.';
        state.alertTone = 'success';
        renderWizard();
        return;
      }
      state.alert = 'Learning režim je aktivní. Připravuji aktuální krok.';
      state.alertTone = 'success';
      armCurrentStep();
    } else if (data.type === 'step_ready') {
      const pending = state.pendingCapture;
      if (!pending || state.completed.has(currentStep()?.key) || data.step !== pending.step ||
          data.command !== pending.command || data.context !== pending.context || data.sample_index !== pending.sampleIndex) return;
      state.deviceReady = true;
      state.listening = true;
      clearOperationTimeout();
      state.alert = 'Přijímač je připraven. Stiskněte zvýrazněné tlačítko.';
      state.alertTone = '';
      renderWizard();
    } else if (data.type === 'stopped') {
      if (data.mode !== 'NORMAL_MODE') return;
      clearOperationTimeout();
      state.running = false;
      state.listening = false;
      state.deviceReady = false;
      state.pendingCapture = null;
      state.sessionId = '';
      if (state.view === 'wizard') openLanding('Learning relace byla ukončena zařízením' + (data.reason ? ` (${data.reason})` : '') + '. Rozpracované vzorky nebyly uloženy do zařízení.', 'error');
    } else if (data.type === 'error') {
      clearOperationTimeout();
      state.listening = false;
      state.pendingCapture = null;
      state.alert = data.message || data.code || 'Zařízení hlásí chybu learning režimu.';
      state.alertTone = 'error';
      renderWizard();
    }
  }

  function startProfileUpload() {
    if (!state.profile || !profileIsSafe(state.profile)) return;
    if (!admin.isConnected()) {
      state.alert = 'Zařízení není připojeno. Profil nelze odeslat.';
      state.alertTone = 'error';
      return renderSummary();
    }
    const error = validateProfile(state.profile);
    if (error) {
      state.alert = error;
      state.alertTone = 'error';
      return renderSummary();
    }
    const bytes = encoder.encode(JSON.stringify(state.profile));
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += PROFILE_CHUNK_BYTES) chunks.push(bytes.slice(offset, offset + PROFILE_CHUNK_BYTES));
    const transferId = makeId('up');
    state.upload = { transferId, profileId: state.profile.profile_id, bytes, chunks, nextIndex: 0, crc: crc32(bytes) };
    state.alert = `Připravuji přenos profilu (${bytes.length} B / ${chunks.length} chunků)…`;
    state.alertTone = '';
    renderSummary();
    admin.publishJson(topics.profileCommand, {
      v: PROTOCOL_VERSION, type: 'begin_upload', transfer_id: transferId,
      total_bytes: bytes.length, chunks: chunks.length, chunk_bytes: PROFILE_CHUNK_BYTES,
      crc32: state.upload.crc
    });
    armOperationTimeout(12000, () => {
      if (!state.upload) return;
      state.upload = null;
      state.alert = 'Zařízení nepotvrdilo zahájení uploadu. Aktivní profil zůstal beze změny.';
      state.alertTone = 'error';
      renderSummary();
    });
    admin.log(`Profil: začátek uploadu ${transferId}, ${bytes.length} B`);
  }

  function sendUploadChunk(index) {
    const upload = state.upload;
    if (!upload || index !== upload.nextIndex || index >= upload.chunks.length) return;
    const topic = `${topics.profileChunk}/${upload.transferId}/${index}`;
    armOperationTimeout(12000, () => {
      if (!state.upload) return;
      state.upload = null;
      state.alert = 'Zařízení nepotvrdilo přijatý chunk. Upload byl bezpečně ukončen.';
      state.alertTone = 'error';
      renderSummary();
    });
    if (!admin.publish(topic, upload.chunks[index])) {
      state.alert = 'Přenos byl přerušen: MQTT není připojeno.';
      state.alertTone = 'error';
      state.upload = null;
      renderSummary();
    }
  }

  function abortProfileUpload(message) {
    clearOperationTimeout();
    state.upload = null;
    state.alert = message;
    state.alertTone = 'error';
    renderSummary();
  }

  function finishDownloadedProfile() {
    const transfer = state.download;
    if (!transfer) return;
    const fail = message => {
      state.download = null;
      state.requestedDownloadId = '';
      openLanding(message, 'error');
    };
    if (transfer.parts.filter(Boolean).length !== transfer.chunks) {
      return fail('Stažený profil není kompletní.');
    }
    const bytes = new Uint8Array(transfer.totalBytes);
    let offset = 0;
    for (const part of transfer.parts) {
      if (offset + part.length > bytes.length) {
        return fail('Stažený profil překročil deklarovanou velikost.');
      }
      bytes.set(part, offset);
      offset += part.length;
    }
    if (offset !== transfer.totalBytes || crc32(bytes) !== transfer.crc) {
      return fail('CRC32 nebo velikost staženého profilu nesouhlasí.');
    }
    let profile;
    try { profile = JSON.parse(decoder.decode(bytes)); } catch {
      return fail('Zařízení poslalo neplatný JSON profil.');
    }
    if (profile?.profile_id !== transfer.profileId) return fail('ID staženého profilu nesouhlasí s oznámeným profilem.');
    const error = validateProfile(profile);
    state.download = null;
    state.requestedDownloadId = '';
    if (error) return openLanding(error, 'error');
    state.profileName = profile.name;
    state.alert = 'Aktivní profil byl bezpečně načten ze zařízení.';
    state.alertTone = 'success';
    showSummary(profile, 'device');
  }

  function handleProfileStatus(data) {
    if (!data || data.v !== PROTOCOL_VERSION) return;
    const upload = state.upload;
    if (data.type === 'upload_ready' && upload && data.transfer_id === upload.transferId) {
      if (data.next_index !== 0 || data.chunk_bytes !== PROFILE_CHUNK_BYTES) return abortProfileUpload('Zařízení potvrdilo neplatné parametry uploadu. Aktivní profil zůstal beze změny.');
      clearOperationTimeout();
      upload.nextIndex = 0;
      state.alert = `Odesílám chunk 1 z ${upload.chunks.length}…`;
      renderSummary();
      sendUploadChunk(0);
    } else if (data.type === 'chunk_ack' && upload && data.transfer_id === upload.transferId) {
      const expectedReceived = Math.min((upload.nextIndex + 1) * PROFILE_CHUNK_BYTES, upload.bytes.length);
      if (data.index !== upload.nextIndex || data.next_index !== upload.nextIndex + 1 || data.received !== expectedReceived) {
        return abortProfileUpload('Zařízení potvrdilo nesprávný index nebo počet bajtů chunku. Upload byl zastaven.');
      }
      upload.nextIndex = data.next_index;
      clearOperationTimeout();
      if (upload.nextIndex < upload.chunks.length) {
        state.alert = `Odesílám chunk ${upload.nextIndex + 1} z ${upload.chunks.length}…`;
        renderSummary();
        sendUploadChunk(upload.nextIndex);
      } else {
        state.alert = 'Všechny chunky potvrzeny. Ověřuji CRC32 a ukládám do NVS…';
        renderSummary();
        admin.publishJson(topics.profileCommand, { v: PROTOCOL_VERSION, type: 'commit_upload', transfer_id: upload.transferId });
        armOperationTimeout(15000, () => {
          if (!state.upload) return;
          state.upload = null;
          state.alert = 'Zařízení nepotvrdilo uložení profilu. Aktivní profil se nepovažuje za změněný.';
          state.alertTone = 'error';
          renderSummary();
        });
      }
    } else if (data.type === 'saved' && upload && data.transfer_id === upload.transferId) {
      if (data.profile_id !== upload.profileId || data.total_bytes !== upload.bytes.length ||
          !Number.isInteger(data.crc32) || (data.crc32 >>> 0) !== upload.crc || data.source !== 'nvs') {
        return abortProfileUpload('Potvrzení uloženého profilu nesouhlasí s odeslanými daty.');
      }
      clearOperationTimeout();
      state.upload = null;
      state.alert = 'Profil byl ověřen, uložen do NVS a aktivován.';
      state.alertTone = 'success';
      admin.log(`Profil: uložen ${state.profile?.profile_id || ''}`);
      renderSummary();
    } else if (data.type === 'download_begin' && data.transfer_id === state.requestedDownloadId) {
      clearOperationTimeout();
      if (!data.transfer_id || !/^[\x21-\x7e]{1,36}$/.test(data.profile_id || '') || !['nvs', 'factory'].includes(data.source) ||
          !Number.isInteger(data.chunks) || data.chunks < 1 || data.chunks > Math.ceil(PROFILE_MAX_BYTES / PROFILE_CHUNK_BYTES) ||
          !Number.isInteger(data.total_bytes) || data.total_bytes < 1 || data.total_bytes > PROFILE_MAX_BYTES ||
          data.chunks !== Math.ceil(data.total_bytes / PROFILE_CHUNK_BYTES) || data.chunk_bytes !== PROFILE_CHUNK_BYTES ||
          !Number.isInteger(data.crc32) || data.crc32 < 0 || data.crc32 > 0xffffffff) {
        state.requestedDownloadId = '';
        return openLanding('Zařízení oznámilo neplatné parametry profilu.', 'error');
      }
      state.download = {
        transferId: data.transfer_id, profileId: data.profile_id, source: data.source,
        chunks: data.chunks, totalBytes: data.total_bytes,
        crc: data.crc32 >>> 0, parts: new Array(data.chunks), nextIndex: 0
      };
      armOperationTimeout(20000, () => {
        state.download = null;
        state.requestedDownloadId = '';
        openLanding('Zařízení nedokončilo odeslání profilu v časovém limitu.', 'error');
      });
    } else if (data.type === 'download_complete' && state.download && data.transfer_id === state.download.transferId) {
      if (data.chunks !== state.download.chunks || data.total_bytes !== state.download.totalBytes ||
          !Number.isInteger(data.crc32) || (data.crc32 >>> 0) !== state.download.crc) {
        state.download = null;
        state.requestedDownloadId = '';
        clearOperationTimeout();
        return openLanding('Závěrečné potvrzení staženého profilu nesouhlasí.', 'error');
      }
      clearOperationTimeout();
      finishDownloadedProfile();
    } else if (data.type === 'factory_restored' && data.transfer_id === state.factoryTransferId) {
      clearOperationTimeout();
      state.factoryTransferId = '';
      state.factoryArmed = false;
      if (data.source !== 'factory' || data.profile_id !== 'derby-factory-v1') {
        return openLanding('Potvrzení továrního profilu nesouhlasí s očekávaným DERBY profilem.', 'error');
      }
      openLanding('Tovární DERBY profil byl obnoven a je aktivní.', 'success');
    } else if (data.type === 'error') {
      const expectedIds = [upload?.transferId, state.requestedDownloadId, state.factoryTransferId].filter(Boolean);
      if (!data.transfer_id || !expectedIds.includes(data.transfer_id)) return;
      clearOperationTimeout();
      if (upload && data.transfer_id === upload.transferId) state.upload = null;
      if (data.transfer_id === state.requestedDownloadId) {
        state.requestedDownloadId = '';
        state.download = null;
      }
      if (data.transfer_id === state.factoryTransferId) state.factoryTransferId = '';
      state.alert = data.message || data.code || 'Zařízení odmítlo operaci s profilem.';
      state.alertTone = 'error';
      if (state.view === 'summary') renderSummary();
      else {
        if (state.running) stopLearning('profile_error');
        openLanding(state.alert, state.alertTone);
      }
    }
  }

  function handleProfileChunk(topic, message) {
    if (!topic.startsWith(`${topics.profileData}/`) || !state.download) return;
    const suffix = topic.slice(topics.profileData.length + 1).split('/');
    if (suffix.length !== 2 || suffix[0] !== state.download.transferId) return;
    const index = Number(suffix[1]);
    if (!Number.isInteger(index) || index < 0 || index >= state.download.chunks) return;
    if (index < state.download.nextIndex) return;
    if (index !== state.download.nextIndex) {
      state.download = null;
      state.requestedDownloadId = '';
      clearOperationTimeout();
      return openLanding('Zařízení poslalo části profilu v nesprávném pořadí.', 'error');
    }
    const bytes = message instanceof Uint8Array ? new Uint8Array(message) : encoder.encode(message.toString());
    if (!bytes.length || bytes.length > PROFILE_CHUNK_BYTES) return;
    state.download.parts[index] = bytes;
    state.download.nextIndex += 1;
    armOperationTimeout(20000, () => {
      state.download = null;
      state.requestedDownloadId = '';
      openLanding('Zařízení nedokončilo odeslání profilu v časovém limitu.', 'error');
    });
  }

  function requestActiveProfile() {
    if (!admin.isConnected()) return openLanding('Zařízení není připojeno.', 'error');
    state.importToken += 1;
    state.download = null;
    const transferId = makeId('down');
    state.requestedDownloadId = transferId;
    showLoading('Načítám aktivní RF profil', 'Čekám na data a kontrolní součet ze zařízení…');
    admin.publishJson(topics.profileCommand, { v: PROTOCOL_VERSION, type: 'get', transfer_id: transferId });
    armOperationTimeout(12000, () => {
      state.requestedDownloadId = '';
      openLanding('Zařízení neodpovědělo na požadavek o aktivní profil.', 'error');
    });
  }

  function confirmFactoryReset() {
    if (!admin.isConnected()) return openLanding('Zařízení není připojeno.', 'error');
    state.importToken += 1;
    const transferId = makeId('factory');
    state.factoryTransferId = transferId;
    admin.publishJson(topics.profileCommand, { v: PROTOCOL_VERSION, type: 'reset_factory', transfer_id: transferId });
    showLoading('Obnovuji tovární profil', 'Zařízení ověřuje a aktivuje vestavěný DERBY profil…');
    armOperationTimeout(15000, () => {
      state.factoryTransferId = '';
      openLanding('Zařízení nepotvrdilo obnovení továrního profilu.', 'error');
    });
  }

  function exportProfile() {
    if (!state.profile) return;
    const blob = new Blob([JSON.stringify(state.profile)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `scorebridge-rf-${state.profile.profile_id}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importProfile(file) {
    if (!file) return;
    if (file.size > PROFILE_MAX_BYTES * 4) return openLanding('Soubor je nepřiměřeně velký pro RF profil.', 'error');
    const token = ++state.importToken;
    let profile;
    try { profile = JSON.parse(await file.text()); } catch {
      if (token !== state.importToken || state.view !== 'landing') return;
      return openLanding('Soubor neobsahuje platný JSON.', 'error');
    }
    if (token !== state.importToken || state.view !== 'landing') return;
    const error = validateProfile(profile);
    if (error) return openLanding(error, 'error');
    state.profileName = profile.name;
    state.alert = 'Profil byl importován. Před uložením zkontrolujte jeho varianty.';
    state.alertTone = 'success';
    showSummary(profile, 'import');
  }

  function showCalibrationExplanation() {
    state.importToken += 1;
    state.view = 'docs';
    admin.setModalView('calibration-docs');
    admin.showModal({
      eyebrow: 'RF learning / metodika', title: 'Jak kalibrace funguje', fullscreen: true,
      body: `<div class="cal-complete">
        <span class="cal-kicker">Deterministický postup</span><h3>Od pulzů k bezpečnému podpisu.</h3>
        <div class="cal-feature-list" style="max-width:820px">
          <div class="cal-feature"><i>1</i><div><strong>Zarovnání podle DERBY syncu</strong><span>Každý frame začíná sekvencí 0:1, 1:1, 0:7, 1:1 s tolerancí jedné jednotky.</span></div></div>
          <div class="cal-feature"><i>2</i><div><strong>Robustní shoda deseti vzorků</strong><span>Zůstanou pozice, které se shodují alespoň v 80 % platných měření.</span></div></div>
          <div class="cal-feature"><i>3</i><div><strong>Porovnání příkazů</strong><span>Greedy set-cover vybere nejmenší sadu stabilních pozic, která odliší všechny překrývající se kontexty.</span></div></div>
          <div class="cal-feature"><i>4</i><div><strong>Validace před aktivací</strong><span>Zařízení přijme profil po sekvenčních chuncích, ověří limity, JSON i CRC32 a teprve potom zapíše NVS.</span></div></div>
        </div>
        <div class="cal-alert">Learning režim nic nevysílá a přijatá tlačítka nemění skóre. Původní tovární DERBY profil zůstává vždy k dispozici jako fallback.</div>
      </div>`,
      footer: '<button data-calibration-action="back-landing">Zpět</button><button class="modal-confirm" data-calibration-action="start" ' + (admin.isConnected() ? '' : 'disabled') + '>Spustit kalibraci</button>'
    });
  }

  admin.onMqttMessage((topic, message) => {
    if (topic === topics.learnStatus) return handleLearningStatus(parseJsonMessage(message));
    if (topic === topics.learnSample) return processLearningSample(parseJsonMessage(message));
    if (topic === topics.profileStatus) return handleProfileStatus(parseJsonMessage(message));
    if (topic.startsWith(`${topics.profileData}/`)) handleProfileChunk(topic, message);
  });

  admin.onConnection(connected => {
    if (!connected) clearOperationTimeout();
    if (!connected && state.running) {
      state.listening = false;
      state.deviceReady = false;
      state.pendingCapture = null;
      const step = currentStep();
      if (!state.preparing && step && !state.completed.has(step.key)) {
        stepVariantKeys(step).forEach(key => state.collected.delete(key));
        state.latestFrame = null;
      }
      state.alert = 'MQTT spojení bylo přerušeno. Nedokončený krok se po návratu změří znovu; hotové kroky zůstávají zachované.';
      state.alertTone = 'error';
      if (state.preparing) showPowerPreparation(); else renderWizard();
    } else if (!connected && state.upload) {
      state.upload = null;
      state.alert = 'Upload byl přerušen. Zařízení neaktivuje nekompletní profil; spusťte uložení znovu.';
      state.alertTone = 'error';
      renderSummary();
    } else if (!connected && state.download) {
      state.download = null;
      state.requestedDownloadId = '';
      openLanding('Načítání profilu přerušilo MQTT spojení.', 'error');
    } else if (!connected && state.view === 'loading') {
      state.requestedDownloadId = '';
      state.factoryTransferId = '';
      openLanding('Operaci se zařízením přerušilo MQTT spojení. Aktivní profil zůstal beze změny.', 'error');
    } else if (!connected && state.view === 'landing') {
      renderLanding();
    } else if (!connected && state.view === 'summary') {
      renderSummary();
    } else if (connected && state.view === 'wizard' && state.running && !state.deviceReady) {
      state.alert = 'Spojení je obnoveno. Obnovuji stejnou learning relaci a zachovávám již dokončené kroky…';
      state.alertTone = '';
      renderWizard();
      publishLearn('start', { timeout_s: LEARNING_TIMEOUT_SECONDS, base_time_us: 830, max_frame_pairs: MAX_FRAME_PAIRS });
      armOperationTimeout(12000, () => {
        if (!state.running || state.deviceReady) return;
        state.alert = 'Zařízení po obnovení spojení nepotvrdilo learning režim.';
        state.alertTone = 'error';
        renderWizard();
      });
    } else if (connected && state.view === 'landing') {
      renderLanding();
    } else if (connected && state.view === 'summary') {
      renderSummary();
    }
  });

  document.addEventListener('click', event => {
    const opener = event.target.closest('[data-calibration-open]');
    if (opener) {
      event.preventDefault();
      state.importToken += 1;
      if (isCalibrationView(admin.getModalView())) leaveCalibration('reopened');
      openLanding();
      return;
    }

    const button = event.target.closest('[data-calibration-action]');
    if (!button) return;
    event.preventDefault();
    const action = button.dataset.calibrationAction;

    if (action === 'start') beginCalibration();
    else if (action === 'close') admin.closeModal();
    else if (action === 'cancel') {
      stopLearning('user_cancelled');
      openLanding('Kalibrace byla zrušena. Aktivní profil zařízení zůstal beze změny.', '');
    } else if (action === 'retry') retryStep();
    else if (action === 'skip') skipStep();
    else if (action === 'next') advanceStep();
    else if (action === 'prepared') advanceStep();
    else if (action === 'start-over') beginCalibration();
    else if (action === 'save-profile') startProfileUpload();
    else if (action === 'export-profile') exportProfile();
    else if (action === 'load-profile') requestActiveProfile();
    else if (action === 'import-profile') document.getElementById('calProfileImport')?.click();
    else if (action === 'arm-factory') {
      state.importToken += 1;
      state.factoryArmed = true;
      state.alert = '';
      renderLanding();
    } else if (action === 'confirm-factory') confirmFactoryReset();
    else if (action === 'documentation') showCalibrationExplanation();
    else if (action === 'back-landing') openLanding();
    else if (action === 'remeasure') remeasureStep(Number(button.dataset.stepIndex));
  });

  document.addEventListener('change', event => {
    if (event.target.id === 'calProfileImport') importProfile(event.target.files?.[0]);
  });

  document.addEventListener('input', event => {
    if (event.target.id !== 'calProfileName' || !state.profile) return;
    const name = truncateUtf8(event.target.value.trim(), 32);
    if (event.target.value !== name) event.target.value = name;
    state.profile.name = name || 'Naučená ovladačka';
    state.profileName = state.profile.name;
  });

  const leaveCalibration = reason => {
    state.importToken += 1;
    clearOperationTimeout();
    if (state.running) stopLearning(reason);
    if (state.upload) {
      admin.log('Profil: lokální upload zrušen zavřením okna');
    }
    state.upload = null;
    state.download = null;
    state.requestedDownloadId = '';
    state.factoryTransferId = '';
    state.factoryArmed = false;
    state.view = 'closed';
    document.getElementById('appModal')?.classList.remove('calibration-modal');
  };

  document.addEventListener('scorebridge:modal-before-close', event => {
    if (isCalibrationView(event.detail?.view)) leaveCalibration('modal_closed');
  });

  document.addEventListener('scorebridge:modal-view-changing', event => {
    if (isCalibrationView(event.detail?.from) && !isCalibrationView(event.detail?.to)) leaveCalibration('view_changed');
  });

  const openCalibration = () => {
    if (isCalibrationView(admin.getModalView()) || state.running || state.upload || state.download || state.factoryTransferId) {
      leaveCalibration('api_reopened');
    }
    openLanding();
  };

  window.ScoreBridgeCalibration = Object.freeze({
    open: openCalibration,
    validateProfile,
    analyzeSamples: summarizeSamples,
    buildProfile,
    crc32
  });
})();
