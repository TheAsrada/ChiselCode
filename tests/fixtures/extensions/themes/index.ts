import type {
  ExtensionFactory,
  ThemeContribution,
} from "chiselcode/extension-sdk";

const themes: readonly ThemeContribution[] = [
  {
    id: "north",
    name: "Север",
    description: "Спокойная тёмная тема с голубым акцентом.",
    variant: "dark",
    colors: {
      bg: "#101622",
      surface: "#192233",
      raised: "#263044",
      border: "#64738b",
      text: "#f3f6ff",
      muted: "#b7c3da",
      accent: "#9cbaff",
      green: "#92ddb8",
      red: "#ff9ea3",
      yellow: "#eed793",
    },
  },
  {
    id: "linen",
    name: "Лён",
    description: "Светлый тёплый фон и выразительный синий акцент.",
    variant: "light",
    colors: {
      bg: "#f7f4ee",
      surface: "#efe9dd",
      raised: "#e3dbca",
      border: "#939283",
      text: "#202936",
      muted: "#47546b",
      accent: "#294c93",
      green: "#236447",
      red: "#98313c",
      yellow: "#765013",
    },
  },
];
const factory: ExtensionFactory = ({ manifest }) => ({
  id: manifest.id,
  version: manifest.version,
  apiVersion: 1,
  entry: manifest.entry,
  themes,
  activate() {},
});
export default factory;
