import { Group, Circle } from 'react-konva';
import { patchCompositeResize, compositeRingLayers, getOutline, outlineActive } from '../model/objectModel';

/**
 * Renders a Dot + Rings: ONE object drawn as a single Konva Group holding every ring and the dot. The group is
 * the thing that is selected, dragged and resized, so the parts can never separate. Resizing scales the dot and
 * every ring by the same factor (see patchCompositeResize).
 *
 * Every radius comes from `compositeRingLayers` — the same function the public page and the PDF draw from:
 *   - attached rings (`metadata.rings`): each ring's inner edge is exactly the previous layer's outer edge (ZERO gap);
 *   - the older single spaced ring (`metadata.ring`): drawn exactly as before.
 * Layers are drawn outermost first, then inward, with the dot on top; an outline is an underlay beneath its own
 * layer (same geometry, outline colour, `2 × outline thickness` wider stroke) — identical to renderMarkings.js.
 */
export default function DotRingShape({ object, canvas, onSelect, onChange, nodeRef }) {
  const dotRadiusPx = ((object.width || 0.03) / 2) * canvas.width;
  const layers = compositeRingLayers(object, canvas.width);
  const dotOutline = getOutline(object);
  const attached = layers.length > 0 && !layers[0].legacy;

  const parts = [];
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const L = layers[i];
    if (attached && outlineActive(L.outline)) {
      parts.push(<Circle key={`ring-${i}-outline`} radius={L.radius} stroke={L.outline.color} strokeWidth={L.thickness + 2 * L.outline.thickness} />);
    }
    parts.push(<Circle key={`ring-${i}`} radius={L.radius} stroke={L.color} strokeWidth={L.thickness} />);
  }
  if (outlineActive(dotOutline)) {
    parts.push(<Circle key="dot-outline" radius={dotRadiusPx} fill={dotOutline.color} stroke={dotOutline.color} strokeWidth={2 * dotOutline.thickness} />);
  }
  parts.push(<Circle key="dot" radius={dotRadiusPx} fill={object.color} />);

  return (
    <Group
      ref={nodeRef}
      x={object.x * canvas.width}
      y={object.y * canvas.height}
      opacity={object.opacity}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => {
        onChange({ x: e.target.x() / canvas.width, y: e.target.y() / canvas.height });
      }}
      onTransformEnd={(e) => {
        const node = e.target;
        const factor = (node.scaleX() + node.scaleY()) / 2;
        node.scaleX(1);
        node.scaleY(1);
        onChange({
          x: node.x() / canvas.width,
          y: node.y() / canvas.height,
          ...patchCompositeResize(object, factor),
        });
      }}
    >
      {parts}
    </Group>
  );
}
