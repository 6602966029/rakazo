import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";

/** Connected apps, or artwork-first suggestions from the already loaded catalog. */
export function connectedAppMarks(
  catalog: readonly ConnectionCatalogItem[],
  connections: readonly Connection[],
) {
  const connected = catalog.filter(
    (item) =>
      item.connected ||
      connections.some(
        (row) =>
          row.status === "connected" &&
          row.connectorId === item.connectorId &&
          row.provider.toLowerCase() === item.slug.toLowerCase(),
      ),
  );
  const apps = connected.length
    ? connected
    : [...catalog].sort((a, b) => Number(Boolean(b.logo)) - Number(Boolean(a.logo)));
  return apps
    .filter((item, index, apps) => apps.findIndex((app) => app.name === item.name) === index)
    .slice(0, 3)
    .map(({ name, logo }) => ({ name, logo }));
}
