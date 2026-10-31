// Test double for `react-konva` (real Konva needs a browser canvas). Each component renders a plain element and RECORDS the props it was
// given in globalThis.__konva, so tests can check what the shapes tell Konva to draw and call their event handlers with fake events.
import { createElement, forwardRef } from 'react';

const calls = (globalThis.__konva = globalThis.__konva || []);
const safe = (props) => Object.fromEntries(Object.entries(props).filter(([k, v]) => k !== 'children' && k !== 'ref' && typeof v !== 'function' && typeof v !== 'object'));
const make = (name) => forwardRef(function KonvaStub(props, ref) { // eslint-disable-line prefer-arrow-callback
  calls.push({ name, props });
  return createElement('div', { 'data-konva': name, 'data-props': JSON.stringify(safe(props)) }, props.children);
});

export const Stage = make('Stage');
export const Layer = make('Layer');
export const Image = make('Image');
export const Transformer = make('Transformer');
export const Line = make('Line');
export const Arrow = make('Arrow');
export const Circle = make('Circle');
export const Group = make('Group');
export const Text = make('Text');
export const Rect = make('Rect');
export const RegularPolygon = make('RegularPolygon');
export const Path = make('Path');
export const konvaCalls = () => calls;
export const resetKonva = () => { calls.length = 0; };
