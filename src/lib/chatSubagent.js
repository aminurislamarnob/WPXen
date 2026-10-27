// The open / closed state a subagent row reports to the main process, which
// decodes and sends a subagent's nested rows only while a row has it open.
// A row that unmounts open — scrolled out of the virtualised list, or the
// chat closing — reports closed, or the main process would go on tailing
// it for nobody.
export function subagentExpansion(send) {
  let open = false;
  return {
    set(next) {
      const value = !!next;
      if (value === open) return;
      open = value;
      send(value);
    },
    release() {
      if (!open) return;
      open = false;
      send(false);
    },
  };
}
