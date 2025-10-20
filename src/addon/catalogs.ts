import { Args } from "stremio-addon-sdk";
import { searchJackettRaw } from "../torrent/jackett.js";
import { JackettCategory } from "ts-jackett-api/lib/types/JackettCategory.js";
import { Request } from "express";
import { getReadableSize } from "../utils/file.js";

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
    const jackettResults = await searchJackettRaw(
        args.extra.search,
        [JackettCategory.Movies, JackettCategory.TV],
        args.config?.jackettUrl,
        args.config?.jackettKey
    )

    const metadata = jackettResults.map((jackettResult, i) => {
        return {
            id: `jackett${jackettResult.Link}`,
            name: jackettResult.Title,
            releaseInfo: jackettResult.Year,
            poster: jackettResult.Poster,
            posterShape: 'poster',
            website: jackettResult.Details,
            description: jackettResult.Seeders + ' seeds • ' + getReadableSize(jackettResult.Size) + ' • ' + jackettResult.Tracker,
            type: 'other'
        }
    })
    
    if(metadata.length === 0) {
        return Promise.resolve({ metas: [] })
    }

    return Promise.resolve({ metas: metadata })
}