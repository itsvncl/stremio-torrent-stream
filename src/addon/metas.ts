import { Args, ContentType, MetaDetail, MetaVideo, Stream } from "stremio-addon-sdk";
import { getTorrentInfoFromWebtorrent, TorrentInfo } from "../torrent/webtorrent.js";
import { getTorrentInfoFromTorrentFile } from "../utils/torrent.js";
import { getReadableSize, isVideoFile } from "../utils/file.js";
import { Request } from "express";
import { getStreamUrl } from "./streams.js";

interface HandlerArgs extends Args {
    id: string;
    type: ContentType;
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

export const jackettMetaHandler = async (args: HandlerArgs) => {
    let torrentInfo: TorrentInfo | undefined;

    let uri = args.id;
    if (args.id.startsWith("jackett")) {
        uri = args.id.replace(/^jackett/, '');
    }

    try {
        const res = await fetch(uri, { redirect: "manual" });
        if (res.status === 302 || res.status === 301) {
            const location = res.headers.get("location")!;
            if (location.startsWith("magnet:")) {
                uri = location;
            }
        }

        if (uri.startsWith("magnet:")) {
            torrentInfo = await getTorrentInfoFromWebtorrent(uri);
        } else {
            const torrentBuffer = await res.arrayBuffer();
            torrentInfo = await getTorrentInfoFromTorrentFile(torrentBuffer);
        }
    } catch (e: unknown) {
        console.error("Error during torrent info fetching:", e);
        throw new Error("Failed to fetch torrent info");
    }


    let videos = torrentInfo.files.filter((file) => isVideoFile(file.name));

    const streamEndpointHost = args.config?.streamHost
        ? `${args.config.streamHost}`
        : `${args.req.protocol}://${args.req.get("host")}`;
    
    const metaObj: MetaDetail = {
        id: args.id,
        name: torrentInfo.name,
        //convert bytes to human-readable format
        description: `Size: ${getReadableSize(torrentInfo.size)}`,
        type: args.type,
        videos: videos.map((file, i): MetaVideo => ({
            id: `video_${i}`,
            title: file.name,
            released: new Date().toISOString(),
            streams: [
                {
                    title: file.name,
                    url: getStreamUrl(streamEndpointHost, torrentInfo.infoHash, uri, file.path)
                }
            ]
        })),
    };

    return { meta: metaObj };
};
