export const guessLanguages = (name: string, category?: string) => {
  const languages = new Set();
  if (category?.includes("HU")) languages.add("🇭🇺");
  if (category?.includes("EN")) languages.add("🇬🇧");

  const languageMap: { [key: string]: string } = {
    hun: "🇭🇺",
    hungarian: "🇭🇺",
    ger: "🇩🇪",
    german: "🇩🇪",
    fre: "🇫🇷",
    french: "🇫🇷",
    ita: "🇮🇹",
    italian: "🇮🇹",
    eng: "🇬🇧",
    english: "🇬🇧",
    rus: "🇷🇺",
    russian: "🇷🇺",
    spa: "🇪🇸",
    spanish: "🇪🇸",
    multi: "🌍",
  };

  const regex = new RegExp(Object.keys(languageMap).join("|"), "gi");
  const matches = name.toLowerCase().match(regex);

  if (matches) matches.forEach((match) => languages.add(languageMap[match]));
  else languages.add("🇬🇧");

  return [...languages].join("/");
};
