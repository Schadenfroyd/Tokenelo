/** Keep a chart disclosure inside the visible chart and its scrolling panel. */
export function positionChartTooltip(host: HTMLElement, anchor: Element, tooltip: HTMLElement): void {
  tooltip.classList.add('visible');
  const hostRect = host.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const panelRect = host.closest('#panel, #detail-panel')?.getBoundingClientRect();
  const halfWidth = tooltip.offsetWidth / 2;
  const left = Math.max(0, (panelRect?.left ?? hostRect.left) - hostRect.left) + halfWidth + 4;
  const right = Math.max(left, Math.min(hostRect.width, (panelRect?.right ?? hostRect.right) - hostRect.left) - halfWidth - 4);
  const top = Math.max(0, (panelRect?.top ?? hostRect.top) - hostRect.top) + 4;
  const bottom = Math.max(top, Math.min(hostRect.height, (panelRect?.bottom ?? hostRect.bottom) - hostRect.top) - tooltip.offsetHeight - 4);
  const preferredX = anchorRect.left - hostRect.left + anchorRect.width / 2;
  const preferredY = anchorRect.top - hostRect.top - tooltip.offsetHeight - 6;
  tooltip.style.left = `${Math.min(Math.max(preferredX, left), right)}px`;
  tooltip.style.top = `${Math.min(Math.max(preferredY, top), bottom)}px`;
}
