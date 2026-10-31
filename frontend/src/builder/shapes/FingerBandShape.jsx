import { Group, Line } from 'react-konva';
import { getBand, patchBandDrag, patchBandTransform } from '../model/objectModel';
import { projectToAxis } from '../model/fingerGeometry';

/**
 * Renders a Finger Band as a short, slightly curved strip laid ACROSS the finger (the curve suggests it
 * wrapping round), with a pale halo so it stays visible on the line drawing. It is rotated to sit across its
 * finger's axis, and dragging it slides it along that finger instead of letting it float free.
 */
export default function FingerBandShape({ object, canvas, onSelect, onChange, nodeRef }) {
  const widthPx = (object.width || 0.13) * canvas.width;
  const thicknessPx = Math.max(1, object.thickness || 4);
  const half = widthPx / 2;
  const bow = widthPx * 0.1;
  const band = getBand(object);
  const line = (offsetY) => [-half, offsetY, 0, bow + offsetY, half, offsetY];
  const size = { width: canvas.width, height: canvas.height };

  return (
    <Group
      ref={nodeRef}
      x={object.x * canvas.width}
      y={object.y * canvas.height}
      rotation={object.rotation || 0}
      opacity={object.opacity}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragMove={(e) => {
        // keep the band on its finger while it is being dragged
        const node = e.target;
        const p = object.finger ? projectToAxis(canvas.viewKey, object.finger, size, node.x() / canvas.width, node.y() / canvas.height) : null;
        if (p) node.position({ x: p.x * canvas.width, y: p.y * canvas.height });
      }}
      onDragEnd={(e) => {
        onChange(patchBandDrag(object, canvas.viewKey, size, e.target.x() / canvas.width, e.target.y() / canvas.height));
      }}
      onTransformEnd={(e) => {
        const node = e.target;
        const newWidthPx = widthPx * node.scaleX();
        const rotation = node.rotation();
        node.scaleX(1);
        node.scaleY(1);
        onChange(patchBandTransform(object, canvas.viewKey, size, { widthNorm: newWidthPx / canvas.width, rotation }));
      }}
    >
      <Line points={line(0)} tension={0.5} stroke="#ffffff" strokeWidth={thicknessPx + 4} lineCap="round" opacity={0.85} listening={false} />
      {band.type === 'double' && (
        <Line points={line(thicknessPx * 2.4)} tension={0.5} stroke={object.color} strokeWidth={thicknessPx} lineCap="round" listening={false} />
      )}
      <Line points={line(0)} tension={0.5} stroke={object.color} strokeWidth={thicknessPx} lineCap="round" hitStrokeWidth={Math.max(thicknessPx, 18)} />
    </Group>
  );
}
