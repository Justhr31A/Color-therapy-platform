import { Circle } from 'react-konva';

/** Renders `dot` and `ring` object types as a Konva Circle. */
export default function RadialShape({ object, canvas, isSelected, onSelect, onChange, nodeRef }) {
  const radiusPx = ((object.width || 0.03) / 2) * canvas.width;
  const isRing = object.type === 'ring';

  return (
    <Circle
      ref={nodeRef}
      x={object.x * canvas.width}
      y={object.y * canvas.height}
      radius={radiusPx}
      fill={isRing ? undefined : object.color}
      stroke={isRing ? object.color : undefined}
      strokeWidth={isRing ? object.thickness : 0}
      opacity={object.opacity}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => {
        onChange({
          x: e.target.x() / canvas.width,
          y: e.target.y() / canvas.height,
        });
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
        });
      }}
    />
  );
}
