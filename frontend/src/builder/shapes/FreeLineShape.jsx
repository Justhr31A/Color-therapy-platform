import { Line } from 'react-konva';

/**
 * Renders `freeline`. Stored as a structured array of normalized {x, y}
 * points (never flattened into the background image). The whole line can be
 * dragged as a unit; dragging translates every point rather than moving the
 * shape via a transform offset, so `points` stays the single source of truth.
 */
export default function FreeLineShape({ object, canvas, onSelect, onChange, nodeRef }) {
  const pxPoints = (object.points || []).flatMap((p) => [p.x * canvas.width, p.y * canvas.height]);

  return (
    <Line
      ref={nodeRef}
      x={0}
      y={0}
      points={pxPoints}
      stroke={object.color}
      strokeWidth={object.thickness}
      opacity={object.opacity}
      lineCap="round"
      lineJoin="round"
      tension={0}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => {
        const node = e.target;
        const dx = node.x() / canvas.width;
        const dy = node.y() / canvas.height;
        node.x(0);
        node.y(0);
        const newPoints = (object.points || []).map((p) => ({ x: p.x + dx, y: p.y + dy }));
        onChange({ points: newPoints });
      }}
    />
  );
}
