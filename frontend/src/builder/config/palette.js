/**
 * The ONE place the Studio's colour palette is defined. Every colour control
 * reads it through getPalette(); nothing else hard-codes swatches. To change
 * the palette (add, remove, recolour) edit this list — later it can be loaded
 * from settings without touching any component.
 *
 * Values are 6-digit hex on purpose: the backend's publish validation only
 * accepts hex colours (colour ends up in canvas/SVG drawing code).
 */
export const COLOR_PALETTE = Object.freeze([
  { key: 'red', name: 'Red', value: '#e5484d' },
  { key: 'orange', name: 'Orange', value: '#f76b15' },
  { key: 'amber', name: 'Amber', value: '#ffb224' },
  { key: 'yellow', name: 'Yellow', value: '#f5d90a' },
  { key: 'green', name: 'Green', value: '#46a758' },
  { key: 'teal', name: 'Teal', value: '#12a594' },
  { key: 'cyan', name: 'Cyan', value: '#05a2c2' },
  { key: 'blue', name: 'Blue', value: '#1a73e8' },
  { key: 'indigo', name: 'Indigo', value: '#3e63dd' },
  { key: 'violet', name: 'Violet', value: '#8e4ec6' },
  { key: 'magenta', name: 'Magenta', value: '#d6409f' },
  { key: 'brown', name: 'Brown', value: '#a18072' },
  { key: 'black', name: 'Black', value: '#111111' },
  { key: 'white', name: 'White', value: '#ffffff' },
]);

export const DEFAULT_OBJECT_COLOR = COLOR_PALETTE[0].value;

export function getPalette() {
  return COLOR_PALETTE;
}

/** Name of a palette colour for tooltips, or the hex itself for a custom colour. */
export function colorName(hex) {
  const found = COLOR_PALETTE.find((c) => c.value.toLowerCase() === String(hex).toLowerCase());
  return found ? found.name : String(hex);
}
