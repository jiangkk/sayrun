export const palette = {
  bg: '#12161d', panel: '#191f29', edge: '#344152', text: '#e3e9f2',
  muted: '#90a0b5', accent: '#82c9c1', amber: '#edc77b', red: '#f08c91', green: '#9cd5ac',
};

export function terminalPalette(noColor = false) {
  return noColor || process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb'
    ? { ...palette, accent: '#ffffff', green: '#ffffff', red: '#ffffff', amber: '#ffffff', muted: '#aaaaaa' }
    : palette;
}
