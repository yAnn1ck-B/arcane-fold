import { useLayoutEffect, useRef, useState } from "react";

export interface BlockAssignment {
  blockerId: string;
  attackerId: string;
}

export function CombatLinks({ assignments }: { assignments: BlockAssignment[] }) {
  const overlay = useRef<SVGSVGElement>(null);
  const [links, setLinks] = useState<{ id: string; path: string }[]>([]);

  useLayoutEffect(() => {
    const svg = overlay.current;
    const arena = svg?.parentElement;
    if (!svg || !arena) return;
    const cards = new Map([...arena.querySelectorAll<HTMLElement>("[data-combat-id]")]
      .map(card => [card.dataset.combatId, card]));
    const update = () => {
      const bounds = svg.getBoundingClientRect();
      setLinks(assignments.flatMap(({ blockerId, attackerId }) => {
        const blocker = cards.get(blockerId)?.getBoundingClientRect();
        const attacker = cards.get(attackerId)?.getBoundingClientRect();
        if (!blocker?.width || !attacker?.width) return [];
        const fromBelow = blocker.y > attacker.y;
        const startX = blocker.x + blocker.width / 2 - bounds.x;
        const endX = attacker.x + attacker.width / 2 - bounds.x;
        const startY = (fromBelow ? blocker.top : blocker.bottom) - bounds.y;
        const endY = (fromBelow ? attacker.bottom : attacker.top) - bounds.y;
        const middleY = (startY + endY) / 2;
        return [{
          id: blockerId + "/" + attackerId,
          path: `M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`,
        }];
      }));
    };
    const resize = new ResizeObserver(update);
    resize.observe(arena);
    for (const { blockerId, attackerId } of assignments) {
      const blocker = cards.get(blockerId);
      const attacker = cards.get(attackerId);
      if (blocker) resize.observe(blocker);
      if (attacker) resize.observe(attacker);
    }
    update();
    return () => resize.disconnect();
  }, [assignments]);

  return (
    <svg ref={overlay} className="pt-combat-links" aria-hidden="true">
      {links.map(link => (
        <g key={link.id} className="pt-combat-link">
          <path d={link.path} />
          <path d={link.path} />
        </g>
      ))}
    </svg>
  );
}
