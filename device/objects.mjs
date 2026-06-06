const FIXED = {
  'live.thisdevice': { inlets: 1, outlettype: ['bang', 'int', 'int'] },
  'live.path': { inlets: 1, outlettype: ['', '', ''] },
  'live.observer': { inlets: 2, outlettype: ['', ''] },
  'live.object': { inlets: 2, outlettype: [''] },
  'node.script': { inlets: 1, outlettype: ['', ''] },
  'plugin~': { inlets: 2, outlettype: ['signal', 'signal'] },
  'plugout~': { inlets: 2, outlettype: ['signal', 'signal'] },
  deferlow: { inlets: 1, outlettype: [''] },
  prepend: { inlets: 1, outlettype: [''] },
  i: { inlets: 2, outlettype: ['int'] },
  gate: { inlets: 2, outlettype: [''] },
};

const TRIGGER_TYPES = { b: 'bang', i: 'int', f: 'float', l: '', s: '', a: '' };

export function objectSpec(text) {
  const [cls, ...args] = text.split(/\s+/);
  const firstAttr = args.findIndex((a) => a.startsWith('@'));
  const plainArgs = firstAttr === -1 ? args : args.slice(0, firstAttr);
  if (cls === 'route') {
    return { inlets: 2, outlets: plainArgs.length + 1, outlettype: Array(plainArgs.length + 1).fill('') };
  }
  if (cls === 't' || cls === 'trigger') {
    const types = plainArgs.map((a) => {
      if (!(a in TRIGGER_TYPES)) throw new Error(`unsupported trigger type "${a}" in "${text}"`);
      return TRIGGER_TYPES[a];
    });
    return { inlets: 1, outlets: types.length, outlettype: types };
  }
  const fixed = FIXED[cls];
  if (!fixed) throw new Error(`no inlet/outlet spec for "${cls}" — add it to device/objects.mjs from a Max-saved box`);
  return { inlets: fixed.inlets, outlets: fixed.outlettype.length, outlettype: [...fixed.outlettype] };
}

export const UI = {
  message: { numinlets: 2, numoutlets: 1, outlettype: [''] },
  comment: { numinlets: 1, numoutlets: 0 },
  'live.comment': { numinlets: 1, numoutlets: 0 },
  textedit: { numinlets: 1, numoutlets: 4, outlettype: ['', 'int', '', ''] },
  'live.text': { numinlets: 1, numoutlets: 2, outlettype: ['', ''] },
};
