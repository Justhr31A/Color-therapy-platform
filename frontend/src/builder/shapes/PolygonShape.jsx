import { RegularPolygon } from 'react-konva';

/** Renders `triangle` and `invertedTriangle`. Inverted = rotated 180°. */
export default function PolygonShape({ object, canvas, onSelect, onChange, nodeRef }) {
  const radiusPx = ((object.width || 0.12) / 2) * canvas.width;

  return (
    <RegularPolygon
      ref={nodeRef}
      sides={3}
      x={object.x * canvas.width}
      y={object.y * canvas.height}
      radius={radiusPx}
      rotation={object.rotation || 0}
      fill={object.color}
      stroke={object.color}
      strokeWidth={object.thickness}
      opacity={object.opacity}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => {
        onChange({ x: e.target.x() / canvas.width, y: e.target.y() / canvas.height });
      }}
      onTransformEnd={(e) => {
        const node = e.target;
        const scale = (node.scaleX() + node.scaleY()) / 2;
        const newRadiusPx = node.radius() * scale;
        node.scaleX(1);
        node.scaleY(1);
        node.radius(newRadiusPx);
        onChange({
          x: node.x() / canvas.width,
          y: node.y() / canvas.height,
          width: (newRadiusPx * 2) / canvas.width,
          height: (newRadiusPx * 2) / canvas.width,
          rotation: node.rotation(),
        });
      }}
    />
  );
}
