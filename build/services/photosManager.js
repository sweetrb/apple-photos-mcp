import { runPhotosReader, checkDependencies } from "../utils/python.js";
/**
 * macOS denies reading the Photos library without Full Disk Access; osxphotos
 * then surfaces a low-level error like "unable to open database file". Append
 * actionable guidance so the failure is self-service rather than cryptic.
 */
function augmentPermissionError(message) {
    if (/not permitted|permission|full disk|denied|unable to open/i.test(message)) {
        return (`${message}\n\nThis looks like a macOS permission issue: the app running this ` +
            `MCP server needs Full Disk Access (System Settings → Privacy & Security → ` +
            `Full Disk Access). Run the \`doctor\` tool for a full diagnosis, or see ` +
            `docs/FULL-DISK-ACCESS.md.`);
    }
    return message;
}
export class PhotosManager {
    /**
     * Build the CLI args common to every subcommand.
     * Library path is optional; when omitted, osxphotos uses the system library.
     */
    libraryArgs(library) {
        return library ? ["--library", library] : [];
    }
    run(command, args, timeoutMs) {
        const result = runPhotosReader(command, args, timeoutMs);
        if (result.error) {
            throw new Error(augmentPermissionError(result.error));
        }
        if (!result.data) {
            throw new Error("Python script returned no data");
        }
        return result.data;
    }
    healthCheck() {
        const dep = checkDependencies();
        if (!dep.ok)
            return dep;
        try {
            const result = this.run("health", []);
            return {
                ok: true,
                message: `osxphotos ${result.osxphotosVersion}, library ${result.libraryPath} (${result.photoCount} photos)`,
            };
        }
        catch (err) {
            return {
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            };
        }
    }
    getLibraryInfo(library) {
        return this.run("library-info", this.libraryArgs(library));
    }
    query(filters, library) {
        const args = this.libraryArgs(library);
        const repeatable = [
            ["uuid", "--uuid"],
            ["album", "--album"],
            ["keyword", "--keyword"],
            ["person", "--person"],
        ];
        for (const [key, flag] of repeatable) {
            const values = filters[key];
            if (values) {
                for (const v of values) {
                    args.push(flag, v);
                }
            }
        }
        if (filters.fromDate)
            args.push("--from-date", filters.fromDate);
        if (filters.toDate)
            args.push("--to-date", filters.toDate);
        if (filters.favorite)
            args.push("--favorite");
        if (filters.notFavorite)
            args.push("--not-favorite");
        if (filters.hidden)
            args.push("--hidden");
        if (filters.notHidden)
            args.push("--not-hidden");
        if (filters.photos)
            args.push("--photos");
        if (filters.movies)
            args.push("--movies");
        if (filters.title)
            args.push("--title", filters.title);
        if (filters.description)
            args.push("--description", filters.description);
        if (filters.limit !== undefined)
            args.push("--limit", String(filters.limit));
        return this.run("query", args);
    }
    getPhoto(uuid, library) {
        const result = this.run("get-photo", [
            ...this.libraryArgs(library),
            "--uuid",
            uuid,
        ]);
        return result.photo;
    }
    listAlbums(library) {
        return this.run("list-albums", this.libraryArgs(library));
    }
    listFolders(library) {
        return this.run("list-folders", this.libraryArgs(library));
    }
    listKeywords(limit, library) {
        const args = this.libraryArgs(library);
        if (limit !== undefined)
            args.push("--limit", String(limit));
        return this.run("list-keywords", args);
    }
    listPersons(limit, library) {
        const args = this.libraryArgs(library);
        if (limit !== undefined)
            args.push("--limit", String(limit));
        return this.run("list-persons", args);
    }
    exportPhotos(uuids, dest, options = {}) {
        if (uuids.length === 0) {
            throw new Error("At least one UUID is required to export");
        }
        const args = this.libraryArgs(options.library);
        for (const uuid of uuids) {
            args.push("--uuid", uuid);
        }
        args.push("--dest", dest);
        if (options.edited)
            args.push("--edited");
        if (options.live)
            args.push("--live");
        if (options.raw)
            args.push("--raw");
        if (options.overwrite)
            args.push("--overwrite");
        // Generous timeout: when originals aren't on disk we fall back to
        // Photos.app/AppleScript, which downloads from iCloud on demand. A batch
        // of missing photos can move serious bytes.
        return this.run("export", args, 30 * 60 * 1000);
    }
}
