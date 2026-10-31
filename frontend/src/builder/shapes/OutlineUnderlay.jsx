import { Group, Circle, Line, Rect, Path } from 'react-konva';
import { outlinePrimitivesForObject } from '../../viewer/renderMarkings';

/**
 * The outline of any (non-composite) shape, drawn as a non-interactive layer BENEATH the shape's own Konva node.
 *
 * It does not work out any geometry itself: it converts the outline primitives from the shared renderer
 * (viewer/renderMarkings.js — the same ones the public page and PDF draw) into Konva nodes, so the outline you see
 * while authoring is by construction the outline that gets published and printed.
 */
const fillOf = (p) => (p.fill && p.fill !== 'none' ? p.fill : undefined);

function node(p, key) {
  switch (p.kind) {
    case 'group':
      return (
        <Group key={key} x={p.transform ? p.transform.tx : 0} y={p.transform ? p.transform.ty : 0} rotation={p.transform ? p.transform.rot || 0 : 0} opacity={p.opacity} listening={false}>
          {p.children.map((c, i) => node(c, i))}
        </Group>
      );
    case 'circle':
      return <Circle key={key} x={p.cx} y={p.cy} radius={p.r} fill={fillOf(p)} stroke={p.stroke} strokeWidth={p.strokeWidth} opacity={p.opacity} listening={false} />;
    case 'line':
      return <Line key={key} points={[p.x1, p.y1, p.x2, p.y2]} stroke={p.stroke} strokeWidth={p.strokeWidth} lineCap={p.cap} opacity={p.opacity} listening={false} />;
    case 'polyline':
      return <Line key={key} points={p.points.flat()} stroke={p.stroke} strokeWidth={p.strokeWidth} lineCap={p.cap} lineJoin={p.join} opacity={p.opacity} listening={false} />;
    case 'polygon':
      return <Line key={key} points={p.points.flat()} closed fill={fillOf(p)} stroke={p.stroke} strokeWidth={p.strokeWidth} opacity={p.opacity} listening={false} />;
    case 'rect':
      return <Rect key={key} x={p.x} y={p.y} width={p.width} height={p.height} fill={fillOf(p)} stroke={p.stroke} strokeWidth={p.strokeWidth} opacity={p.opacity} listening={false} />;
    case 'path': {
      const data = p.segments.map((s) => (s.op === 'M' ? `M ${s.x} ${s.y}` : `Q ${s.cx} ${s.cy} ${s.x} ${s.y}`)).join(' ');
      return <Path key={key} data={data} stroke={p.stroke} strokeWidth={p.strokeWidth} lineCap={p.cap} opacity={p.opacity} listening={false} />;
    }
    default:
      return null;
  }
}

/** `groupRef` lets the caller hide the underlay while its shape is being dragged/resized (it is re-drawn from state on commit). */
export default function OutlineUnderlay({ object, canvas, groupRef }) {
  const prims = outlinePrimitivesForObject(object, canvas);
  if (!prims.length) return null;
  return <Group ref={groupRef} listening={false}>{prims.map((p, i) => node(p, i))}</Group>;
}
