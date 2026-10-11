/* RM adapter for the workspace backup module (per-tool; the shared module is workspace-backup.js).
 * Says which of the tool's saved items belong to the workspace and how to summarise / check them. */
var WB_ADAPTER = (function () {
  'use strict';
  function parseJson(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }
  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  var STATE_KEY = 'rm_state_v1';
  return {
    tool: 'rm',
    toolName: 'Release Management Intelligence Tool',
    version: 'v1.6',
    fileStem: 'rm',
    prefix: ['rm_'],
    // downloaded-guidance cache and "seen" / first-run flags are not user work; they are rebuilt by the tool
    exclude: /^(rm_content_cache_v1|rm_content_seen_v1|rm_version_seen|rm_welcome_done_v1|rm_ob_done_v1)$/,
    extraExcludedNote: 'first-run flags',

    summarise: function (entries) {
      var st = entries[STATE_KEY] !== undefined ? parseJson(entries[STATE_KEY]) : undefined;
      var rel = isObj(st) && Array.isArray(st.releases) ? st.releases.length : 0;
      var def = isObj(st) && Array.isArray(st.defects) ? st.defects.length : 0;
      var other = Object.keys(entries).filter(function (k) { return k !== STATE_KEY; }).length;
      return [['Releases', rel], ['Defects', def], ['Other saved settings', other]];
    },

    hasWork: function (entries) {
      var st = entries[STATE_KEY] !== undefined ? parseJson(entries[STATE_KEY]) : undefined;
      return isObj(st) && ((Array.isArray(st.releases) && st.releases.length > 0) || (Array.isArray(st.defects) && st.defects.length > 0));
    },

    /** '' when fine, otherwise a plain sentence saying what is wrong. */
    validateValue: function (key, value) {
      if (key !== STATE_KEY) return '';
      var st = parseJson(value);
      if (!isObj(st)) return 'The release and defect data in the file is not readable.';
      var bad = null;
      if (st.releases !== undefined && !Array.isArray(st.releases)) bad = 'releases';
      if (st.defects !== undefined && !Array.isArray(st.defects)) bad = 'defects';
      if (bad) return 'The "' + bad + '" in the file is not a list, so it cannot be loaded.';
      var seen = {};
      for (var i = 0; i < (st.releases || []).length; i++) {
        var r = st.releases[i];
        if (!isObj(r) || typeof r.id !== 'string' || !r.id) return 'Release number ' + (i + 1) + ' in the file has no identifier.';
        if (seen[r.id]) return 'Two releases in the file share the same identifier.';
        seen[r.id] = 1;
        if (r.gates !== undefined && !Array.isArray(r.gates)) return 'Release number ' + (i + 1) + ' has gate data that cannot be read.';
      }
      for (var j = 0; j < (st.defects || []).length; j++) {
        var d = st.defects[j];
        if (!isObj(d) || typeof d.id !== 'string' || !d.id) return 'Defect number ' + (j + 1) + ' in the file has no identifier.';
      }
      if (st.dora !== undefined && !isObj(st.dora)) return 'The DORA figures in the file are not readable.';
      if (st.settings !== undefined && !isObj(st.settings)) return 'The settings in the file are not readable.';
      return '';
    },

    /** A readable Markdown summary of the data (for pasting into a wiki page). Not a backup. */
    readable: function (entries) {
      var st = entries[STATE_KEY] !== undefined ? parseJson(entries[STATE_KEY]) : undefined;
      if (!isObj(st)) return '_No release or defect data is saved in this browser._';
      function cell(v) { return String(v == null ? '' : v).split('|').join(String.fromCharCode(166)).split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(10)).join(' ').trim(); }
      var rel = Array.isArray(st.releases) ? st.releases : [], def = Array.isArray(st.defects) ? st.defects : [];
      var open = typeof isUnresolvedBlocker === 'function' ? def.filter(function (d) { return isUnresolvedBlocker(d); }).length : def.filter(function (d) { return d && d.classification === 'blocker'; }).length;
      var out = ['**Releases:** ' + rel.length + '  |  **Defects:** ' + def.length + '  |  **Open release blockers:** ' + open, '', '## Releases', '', '| Release | Type | Target date | Status | RAG | Gates passed or waived |', '|---|---|---|---|---|---|'];
      rel.forEach(function (r) { var g = Array.isArray(r.gates) ? r.gates : []; out.push('| ' + [cell(r.name), cell(r.type), cell(r.targetDate), cell(r.status), cell(r.rag), g.filter(function (x) { return x && (x.status === 'passed' || x.status === 'waived'); }).length + ' / ' + g.length].join(' | ') + ' |'); });
      if (!rel.length) out.push('| _none_ | | | | | |');
      out.push('', '## Defects', '', '| Defect | Severity | Classification | Status | Ticket |', '|---|---|---|---|---|');
      def.forEach(function (d) {
        var key = typeof defectStatusKey === 'function' ? defectStatusKey(d) : d.status;
        var label = typeof DEFECT_STATUS_DEFS !== 'undefined' && DEFECT_STATUS_DEFS[key] ? DEFECT_STATUS_DEFS[key].label : key;
        out.push('| ' + [cell(d.title), cell(d.severity), cell(d.classification), cell(label), cell(d.ticket)].join(' | ') + ' |');
      });
      if (!def.length) out.push('| _none_ | | | | |');
      return out.join(String.fromCharCode(10));
    },

    /** Files made by the old "Export JSON" button: {releases, defects, dora, settings}. Loaded as data only (other saved items are left alone). */
    legacy: function (o) {
      if (!isObj(o) || (!Array.isArray(o.releases) && !Array.isArray(o.defects))) return null;
      var e = {};
      e[STATE_KEY] = JSON.stringify({ releases: o.releases || [], defects: o.defects || [], dora: isObj(o.dora) ? o.dora : { freq: '', lt: '', cfr: '', mttr: '' }, settings: isObj(o.settings) ? o.settings : {} });
      return e;
    }
  };
})();
if (typeof module === 'object' && module.exports) module.exports = WB_ADAPTER;
