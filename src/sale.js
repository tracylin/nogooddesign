// A sale keeps its own record of what went in it. The catalog says what is in
// stock now, and that changes: an inventory update drops what sold out and was
// not restocked, and can reprice what remains. Reading history back through the
// current catalog made sold items vanish from past sales and made old sales
// silently adopt new prices.
//
// Cost is snapshotted for exactly the same reason. What a piece cost moves
// between restocks, and March's profit should not move with it.

export function snapshotOf(item) {
  const line = { id: item.id, name: item.name, price: item.price };
  // A missing cost stays missing. Folding it to zero would report the piece as
  // pure margin, which is worse than admitting the number is not known.
  if (typeof item.cost === "number" && isFinite(item.cost)) line.cost = item.cost;
  return line;
}

export function saleLines(entry, catalog) {
  const ids = (entry && entry.soldCatalogIds) || [];
  const snapshot = Array.isArray(entry && entry.soldItems) ? entry.soldItems : [];
  const byId = new Map(snapshot.map(i => [i.id, i]));
  return ids.map(id => {
    const kept = byId.get(id);
    if (kept) return kept;
    const current = (catalog || []).find(c => c.id === id);
    // Nothing recorded and nothing in the catalog: show the code rather than
    // pretending the item was never there.
    return current ? snapshotOf(current) : { id, name: id, price: null };
  });
}

export function saleNames(entry, catalog) {
  return saleLines(entry, catalog).map(i => i.name).join(", ");
}

export function costOf(line) {
  return typeof line.cost === "number" && isFinite(line.cost) ? line.cost : null;
}
