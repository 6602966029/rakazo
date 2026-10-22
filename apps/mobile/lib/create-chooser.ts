import { presentMessageActionSheet } from "./message-action-sheet";

export function presentCreateChooser({
  t,
  colorScheme,
  onSelect,
}: {
  t: (text: string) => string;
  colorScheme: "light" | "dark";
  onSelect: (action: "bot" | "group" | "space") => void;
}): void {
  presentMessageActionSheet({
    title: t("Create"),
    actions: [
      { text: t("New bot"), onPress: () => onSelect("bot") },
      { text: t("New group"), onPress: () => onSelect("group") },
      { text: t("New space"), onPress: () => onSelect("space") },
    ],
    cancel: t("Cancel"),
    more: t("More"),
    colorScheme,
  });
}
