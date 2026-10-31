import { Line, Arrow } from 'react-konva';

/** Renders `hline`, `vline` and `arrow` as a centered, rotatable segment. */
export default function LinearShape({ object, canvas, onSelect, onChange, nodeRef }) {
  const lengthPx = (object.width || 0.18) * canvas.width;
  const half = lengthPx / 2;
  const points = [-half, 0, half, 0];

  const commitTransform = (e) => {
    const node = e.target;
    const newLengthPx = lengthPx * node.scaleX();
    node.scaleX(1);
    node.scaleY(1);
    onChange({
      x: node.x() / canvas.width,
      y: node.y() / canvas.height,
      width: newLengthPx / canvas.width,
      rotation: node.rotation(),
    });
  };

  const commitDrag = (e) => {
    onChange({ x: e.target.x() / canvas.width, y: e.target.y() / canvas.height });
  };

  const shared = {
    ref: nodeRef,
    x: object.x * canvas.width,
    y: object.y * canvas.height,
    rotation: object.rotation || 0,
    points,
    stroke: object.color,
    strokeWidth: object.thickness,
    opacity: object.opacity,
    lineCap: 'round',
    draggable: true,
    onClick: onSelect,
    onTap: onSelect,
    onDragEnd: commitDrag,
    onTransformEnd: commitTransform,
  };

  if (object.type === 'arrow') {
    return <Arrow {...shared} fill={object.color} pointerLength={Math.max(10, lengthPx * 0.12)} pointerWidth={Math.max(8, lengthPx * 0.1)} />;
  }
  return <Line {...shared} />;
}
