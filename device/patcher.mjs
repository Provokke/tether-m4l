import { objectSpec, UI } from './objects.mjs';

export const DEVICE_WIDTH = 300;
const DEFAULT_URL = 'ws://127.0.0.1:8787/device';

export const SONG_OBSERVERS = [
  ['tempo', 'tempo'],
  ['playing', 'is_playing'],
  ['songTime', 'current_song_time'],
  ['sigNum', 'signature_numerator'],
  ['sigDen', 'signature_denominator'],
  ['tracks', 'tracks'],
  ['scenes', 'scenes'],
];
export const TRACK_OBSERVERS = [
  ['track.name', 'name'],
  ['track.color', 'color'],
  ['track.meter', 'output_meter_level'],
];

export function buildPatcher({ version, bundleName }) {
  const boxes = [];
  const lines = [];
  const ids = new Map();
  const parameters = {};

  const add = (name, box) => {
    if (ids.has(name)) throw new Error(`duplicate box name ${name}`);
    const id = `obj-${ids.size + 1}`;
    ids.set(name, id);
    boxes.push({ box: { id, ...box } });
    return id;
  };
  const width = (text) => Math.max(40, Math.round(text.length * 6.2 + 16));

  const obj = (name, text, x, y, extra = {}) => {
    const s = objectSpec(text);
    return add(name, {
      maxclass: 'newobj', text, numinlets: s.inlets, numoutlets: s.outlets, outlettype: s.outlettype,
      patching_rect: [x, y, width(text), 22], ...extra,
    });
  };
  const msg = (name, text, x, y) => add(name, { maxclass: 'message', text, ...UI.message, patching_rect: [x, y, width(text), 22] });
  const wire = (from, outlet, to, inlet = 0) => {
    for (const n of [from, to]) if (!ids.has(n)) throw new Error(`wire references unknown box ${n}`);
    lines.push({ patchline: { source: [ids.get(from), outlet], destination: [ids.get(to), inlet] } });
  };
  const param = (name, longname, shortname) => {
    parameters[ids.get(name)] = [longname, shortname, 0];
  };

  obj('plugin', 'plugin~', 1660, 40);
  obj('plugout', 'plugout~', 1660, 90);
  wire('plugin', 0, 'plugout', 0);
  wire('plugin', 1, 'plugout', 1);

  obj('ready', 'live.thisdevice', 20, 40);
  obj('readyT', 't b b b b b', 20, 72);
  wire('ready', 0, 'readyT');
  const paths = [
    ['Song', 'path live_set', 20],
    ['View', 'path live_set view', 180],
    ['Track', 'path live_set view selected_track', 340],
    ['Vol', 'path live_set view selected_track mixer_device volume', 620],
  ];
  paths.forEach(([key, text, x], i) => {
    msg(`p${key}`, text, x, 110);
    obj(`lp${key}`, 'live.path', x, 140);
    wire('readyT', 4 - i, `p${key}`);
    wire(`p${key}`, 0, `lp${key}`);
  });
  msg('openGate', '1', 1000, 110);
  wire('readyT', 0, 'openGate');

  obj('node', `node.script ${bundleName} @autostart 1`, 20, 550, {
    saved_object_attributes: { autostart: 1, defer: 0, node_bin_path: '', npm_bin_path: '', watch: 0 },
  });
  obj('inGate', 'gate', 760, 550);
  wire('inGate', 0, 'node');
  const toNode = (from) => wire(from, 0, 'inGate', 1);

  obj('objSong', 'live.object', 1660, 230);
  wire('lpSong', 1, 'objSong', 1);
  obj('objView', 'live.object', 1660, 300);
  wire('lpView', 1, 'objView', 1);
  SONG_OBSERVERS.forEach(([key, prop], i) => {
    const x = 20 + i * 230;
    obj(`obs:${key}`, `live.observer ${prop}`, x, 230);
    obj(`pre:${key}`, `prepend live ${key}`, x, 262);
    wire('lpSong', 1, `obs:${key}`, 1);
    wire(`obs:${key}`, 0, `pre:${key}`);
    toNode(`pre:${key}`);
  });

  obj('trackT', 't b l', 340, 170);
  wire('lpTrack', 1, 'trackT');
  obj('objTrackPath', 'live.object', 20, 440);
  wire('trackT', 1, 'objTrackPath', 1);
  obj('getpathDefer', 'deferlow', 20, 380);
  msg('getpath', 'getpath', 20, 410);
  obj('pre:track.path', 'prepend live track.path', 20, 470);
  wire('trackT', 0, 'getpathDefer');
  wire('getpathDefer', 0, 'getpath');
  wire('getpath', 0, 'objTrackPath');
  wire('objTrackPath', 0, 'pre:track.path');
  toNode('pre:track.path');
  TRACK_OBSERVERS.forEach(([key, prop], i) => {
    const x = 200 + i * 240;
    obj(`obs:${key}`, `live.observer ${prop}`, x, 380);
    obj(`pre:${key}`, `prepend live ${key}`, x, 410);
    wire('trackT', 1, `obs:${key}`, 1);
    wire(`obs:${key}`, 0, `pre:${key}`);
    toNode(`pre:${key}`);
  });
  obj('obs:track.volume', 'live.observer value', 940, 380);
  obj('pre:track.volume', 'prepend live track.volume', 940, 410);
  obj('objVol', 'live.object', 940, 470);
  wire('lpVol', 1, 'obs:track.volume', 1);
  wire('lpVol', 1, 'objVol', 1);
  wire('obs:track.volume', 0, 'pre:track.volume');
  toNode('pre:track.volume');

  obj('nodeOut', 'route cmd status rtt', 20, 590);
  wire('node', 0, 'nodeOut');

  obj('lifecycle', 'route loadend', 420, 590);
  obj('loadT', 't b b b b', 420, 620);
  wire('node', 1, 'lifecycle');
  wire('lifecycle', 0, 'loadT');
  msg('openInput', '1', 560, 650);
  wire('loadT', 3, 'openInput');
  wire('openInput', 0, 'inGate', 0);
  for (const [key] of [...SONG_OBSERVERS, ...TRACK_OBSERVERS, ['track.volume']]) wire('loadT', 2, `obs:${key}`);

  obj('gate', 'gate', 20, 670);
  wire('openGate', 0, 'gate', 0);
  wire('nodeOut', 0, 'gate', 1);
  obj('cmdDefer', 'deferlow', 20, 700);
  wire('gate', 0, 'cmdDefer');
  obj('verbs', 'route play stop tempo volume select fire', 20, 730);
  wire('cmdDefer', 0, 'verbs');

  msg('play', 'call start_playing', 20, 770);
  msg('stop', 'call stop_playing', 160, 770);
  msg('tempo', 'set tempo $1', 290, 770);
  wire('verbs', 0, 'play');
  wire('verbs', 1, 'stop');
  wire('verbs', 2, 'tempo');
  for (const m of ['play', 'stop', 'tempo']) wire(m, 0, 'objSong');

  msg('volume', 'set value $1', 400, 770);
  wire('verbs', 3, 'volume');
  wire('volume', 0, 'objVol');

  msg('selectPath', 'path live_set tracks $1', 520, 770);
  obj('lpSelect', 'live.path', 520, 800);
  obj('selectSet', 'prepend set selected_track', 520, 830);
  wire('verbs', 4, 'selectPath');
  wire('selectPath', 0, 'lpSelect');
  wire('lpSelect', 0, 'selectSet');
  wire('selectSet', 0, 'objView');

  obj('fireT', 't b l', 760, 770);
  msg('firePath', 'path live_set tracks $1 clip_slots $2', 760, 800);
  obj('lpClip', 'live.path', 760, 830);
  obj('objClip', 'live.object', 760, 890);
  msg('fire', 'call fire', 1000, 860);
  wire('verbs', 5, 'fireT');
  wire('fireT', 1, 'firePath');
  wire('firePath', 0, 'lpClip');
  wire('lpClip', 0, 'objClip', 1);
  wire('fireT', 0, 'fire');
  wire('fire', 0, 'objClip');

  const label = (name, text, px, py, w) => add(name, {
    maxclass: 'comment', text, ...UI.comment, patching_rect: [1660, 380 + py * 2, w, 18],
    presentation: 1, presentation_rect: [px, py, w, 18], fontsize: 9.5,
  });
  label('title', `Tether ${version}`, 8, 4, 150);
  label('urlLabel', 'Server', 8, 26, 40);
  label('tokenLabel', 'Token', 8, 48, 40);

  const textParam = (name, varname, longname, shortname, initial, py) => {
    add(name, {
      maxclass: 'textedit', ...UI.textedit,
      patching_rect: [1720, 380 + py * 2, 240, 20],
      presentation: 1, presentation_rect: [50, py, 242, 18],
      text: initial, keymode: 1, lines: 1, outputmode: 1, fontsize: 9.5, fontname: 'Arial',
      parameter_enable: 1, varname,
      saved_attribute_attributes: {
        valueof: {
          parameter_initial: initial ? [initial] : [],
          parameter_initial_enable: initial ? 1 : 0,
          parameter_invisible: 1,
          parameter_longname: longname,
          parameter_modmode: 0,
          parameter_shortname: shortname,
          parameter_type: 3,
        },
      },
    });
    param(name, longname, shortname);
  };
  textParam('url', 'server_url', 'Server URL', 'URL', DEFAULT_URL, 24);
  textParam('token', 'server_token', 'Server Token', 'Token', '', 46);
  obj('preUrl', 'prepend config url', 1980, 428);
  obj('preToken', 'prepend config token', 1980, 472);
  wire('url', 0, 'preUrl');
  wire('token', 0, 'preToken');
  toNode('preUrl');
  toNode('preToken');
  wire('loadT', 1, 'url');
  wire('loadT', 1, 'token');

  add('connect', {
    maxclass: 'live.text', ...UI['live.text'],
    patching_rect: [1660, 540, 80, 20],
    presentation: 1, presentation_rect: [8, 72, 72, 20],
    mode: 1, text: 'Connect', texton: 'Connected',
    parameter_enable: 1, varname: 'connect',
    saved_attribute_attributes: {
      valueof: {
        parameter_enum: ['off', 'on'],
        parameter_invisible: 1,
        parameter_longname: 'Connect',
        parameter_mmax: 1,
        parameter_modmode: 0,
        parameter_shortname: 'Connect',
        parameter_type: 2,
      },
    },
  });
  param('connect', 'Connect', 'Connect');
  obj('connectStore', 'i', 1760, 570);
  obj('preConnect', 'prepend connect', 1660, 600);
  wire('connect', 0, 'connectStore', 1);
  wire('connect', 0, 'preConnect');
  wire('loadT', 0, 'connectStore', 0);
  wire('connectStore', 0, 'preConnect');
  toNode('preConnect');

  add('status', {
    maxclass: 'live.comment', ...UI['live.comment'], text: 'offline', textjustification: 0,
    patching_rect: [200, 620, 100, 18], presentation: 1, presentation_rect: [88, 74, 130, 18],
  });
  obj('preStatus', 'prepend set', 200, 590);
  wire('nodeOut', 1, 'preStatus');
  wire('preStatus', 0, 'status');

  add('rtt', {
    maxclass: 'live.comment', ...UI['live.comment'], text: '', textjustification: 2,
    patching_rect: [310, 620, 80, 18], presentation: 1, presentation_rect: [220, 74, 72, 18],
  });
  msg('rttFmt', 'set $1 ms', 310, 590);
  wire('nodeOut', 2, 'rttFmt');
  wire('rttFmt', 0, 'rtt');

  return {
    patcher: {
      fileversion: 1,
      appversion: { major: 9, minor: 1, revision: 5, architecture: 'x64', modernui: 1 },
      classnamespace: 'box',
      rect: [40, 60, 2200, 1000],
      openrect: [0, 0, DEVICE_WIDTH, 169],
      bglocked: 0,
      openinpresentation: 1,
      default_fontsize: 10,
      default_fontface: 0,
      default_fontname: 'Arial Bold',
      gridonopen: 1,
      gridsize: [8, 8],
      gridsnaponopen: 1,
      objectsnaponopen: 1,
      statusbarvisible: 0,
      toolbarvisible: 1,
      lefttoolbarpinned: 0,
      toptoolbarpinned: 0,
      righttoolbarpinned: 0,
      bottomtoolbarpinned: 0,
      toolbars_unpinned_last_save: 0,
      tallnewobj: 0,
      boxanimatetime: 200,
      enablehscroll: 1,
      enablevscroll: 1,
      devicewidth: DEVICE_WIDTH,
      description: 'Streams Live Set state to a WebSocket server and runs whitelisted remote commands.',
      digest: 'Live API ⇄ WebSocket bridge',
      tags: 'network websocket remote node',
      style: '',
      subpatcher_template: '',
      assistshowspatchername: 0,
      boxes,
      lines,
      parameters: { ...parameters, inherited_shortname: 1 },
      dependency_cache: [],
      latency: 0,
      is_mpe: 0,
      minimum_live_version: '',
      minimum_max_version: '',
      platform_compatibility: 0,
      project: {
        version: 1,
        creationdate: 3_840_000_000,
        modificationdate: 3_840_000_000,
        viewrect: [0, 0, 300, 500],
        autoorganize: 0,
        hideprojectwindow: 1,
        showdependencies: 1,
        autolocalize: 0,
        contents: { patchers: {}, code: {} },
        layout: {},
        searchpath: {},
        detailsvisible: 0,
        amxdtype: 0x61616161,
        readonly: 0,
        devpathtype: 0,
        devpath: '.',
        sortmode: 0,
        viewmode: 0,
      },
      autosave: 0,
    },
  };
}
