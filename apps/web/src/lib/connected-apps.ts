import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";

/** Artwork already loaded by the shell or integrations overlay. */
export function connectedAppMarks(
  catalog: readonly ConnectionCatalogItem[],
  connections: readonly Connection[],
) {
  return catalog
    .filter(
      (item) =>
        item.connected ||
        connections.some(
          (row) =>
            row.status === "connected" &&
            row.connectorId === item.connectorId &&
            row.provider.toLowerCase() === item.slug.toLowerCase(),
        ),
    )
    .filter((item, index, apps) => apps.findIndex((app) => app.name === item.name) === index)
    .slice(0, 3)
    .map(({ name, logo }) => ({ name, logo }));
}
