// DOMRect and VisualViewport offsets/dimensions use the same layout CSS coordinates.
// Window.innerWidth/innerHeight are integers and cannot bound fractional rectangles.
function ownedKeyboardViewportContains(viewport, rectangles) {
  if (!viewport || !Array.isArray(rectangles) || rectangles.length !== 4) return false;
  const {offsetLeft, offsetTop, width, height, scale} = viewport;
  if (![offsetLeft, offsetTop, width, height, scale].every(Number.isFinite) ||
      width <= 0 || height <= 0 || scale <= 0) return false;
  // WebView can round the same edge differently in DOMRect and VisualViewport.
  const edgeRounding = 1 / 1024;
  return rectangles.every(rect => rect &&
    [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 && rect.height > 0 && rect.left >= offsetLeft - edgeRounding && rect.top >= offsetTop - edgeRounding &&
    rect.right <= offsetLeft + width + edgeRounding && rect.bottom <= offsetTop + height + edgeRounding);
}
