import { Rect } from 'react-konva';

/** Renders `rectangle` and `square`, centered on (x, y). */
export default function RectShape({ object, canvas, onSelect, onChange, nodeRef }) {
  const widthPx = (object.width || 0.16) * canvas.width;
  const heightPx = (object.height || 0.1) * canvas.height;

  return (
    <Rect
      ref={nodeRef}
      x={object.x * canvas.width}
      y={object.y * canvas.height}
      width={widthPx}
      height={heightPx}
      offsetX={widthPx / 2}
      offsetY={heightPx / 2}
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
        const newWidthPx = node.width() * node.scaleX();
        const newHeightPx = node.height() * node.scaleY();
        node.scaleX(1);
        node.scaleY(1);
        node.width(newWidthPx);
        node.height(newHeightPx);
        node.offsetX(newWidthPx / 2);
        node.offsetY(newHeightPx / 2);
        onChange({
          x: node.x() / canvas.width,
          y: node.y() / canvas.height,
          width: newWidthPx / canvas.width,
          height: newHeightPx / canvas.height,
          rotation: node.rotation(),
        });
      }}
    />
  );
}
