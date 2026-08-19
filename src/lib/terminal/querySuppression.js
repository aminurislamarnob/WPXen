// Swallow device-status *replies* so they never render as junk text after a
// buffer replay or reattach (e.g. a stray ";1R"). Only response-only sequences
// whose final byte differs from their query are safe to drop — never CSI 'c'
// (DA) or 't' (window ops), where query and reply share the final byte.
export function registerQuerySuppression(term) {
  const p = term.parser;
  p.registerCsiHandler({ final: 'R' }, () => true); // CPR reply (query ends 'n')
  p.registerCsiHandler({ final: 'I' }, () => true); // focus-in report
  p.registerCsiHandler({ final: 'O' }, () => true); // focus-out report
  p.registerCsiHandler({ intermediates: '$', final: 'y' }, () => true); // DECRPM
}
