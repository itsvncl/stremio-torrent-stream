import { Args } from "stremio-addon-sdk";
import { searchJackettRaw } from "../torrent/jackett.js";
import { JackettCategory } from "ts-jackett-api/lib/types/JackettCategory.js";
import { Request } from "express";
import { getReadableSize } from "../utils/file.js";
import stringSimilarity from "string-similarity";

interface HandlerArgs extends Args {
  config?: {
    streamHost: string;
    enableJackett: string;
    jackettUrl: string;
    jackettKey: string;
    enableNcore: string;
    nCoreUser: string;
    nCorePassword: string;
    enableInsane: string;
    insaneUser: string;
    insanePassword: string;
    enableSubtitles: string;
    enableItorrent: string;
    enableYts: string;
    enableEztv: string;
    searchByTitle: string;
    disableHdr: string;
    disableHevc: string;
    disable4k: string;
    disableCam: string;
    disable3d: string;
  };
  req: Request;
}

export const jackettCatalogHandler = async (args: HandlerArgs) => {
  const query = args.extra.search || "";

  const jackettResults = await searchJackettRaw(
    query,
    [JackettCategory.Movies, JackettCategory.TV],
    args.config?.jackettUrl,
    args.config?.jackettKey
  );

  const sorted = jackettResults.sort((a, b) => {
    const simA = stringSimilarity.compareTwoStrings(a.Title.toLowerCase(), query.toLowerCase());
    const simB = stringSimilarity.compareTwoStrings(b.Title.toLowerCase(), query.toLowerCase());
    
    if (simA !== simB) return simB - simA;
    return a.Title.localeCompare(b.Title);
  });

  const metadata = sorted.map((jackettResult) => ({
    id: `jackett${jackettResult.Link}`,
    name: jackettResult.Title,
    releaseInfo: jackettResult.Year,
    poster: jackettResult.Poster,
    posterShape: "poster",
    website: jackettResult.Details,
    description:
      jackettResult.Seeders +
      " seeds • " +
      getReadableSize(jackettResult.Size) +
      " • " +
      jackettResult.Tracker,
    type: "other",
  }));

    if(metadata.length === 0) {
        return Promise.resolve({ metas: [] })
    }

    return Promise.resolve({ metas: metadata })
}