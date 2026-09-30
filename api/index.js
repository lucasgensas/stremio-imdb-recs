const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const TMDB_API_KEY = "d659c9a6006168cfeee99cd51cad6623";
const IMDB_PROFILE_ID = "p.k7ky5tvxj7vurvtblpjto6ck2a";

// 10 Curated Catalogs
const manifest = {
    "id": "org.myself.imdb.tasteprofile.curator",
    "version": "2.0.0",
    "name": "TasteProfile 10-Catalog Engine",
    "description": "Multi-tier personalized catalogs: Mind-bending, Hidden Gems, Prestige Sci-Fi, and Noir.",
    "resources": ["catalog"],
    "types": ["movie", "series"],
    "catalogs": [
        { "type": "movie", "id": "cat_mind_bending", "name": "🧠 Mind-Bending & High-Concept" },
        { "type": "movie", "id": "cat_psych_thriller", "name": "🕵️ Psychological & Tense Thrillers" },
        { "type": "movie", "id": "cat_hidden_gems", "name": "💎 Hidden Gems (Under-The-Radar)" },
        { "type": "movie", "id": "cat_space_scifi", "name": "🌌 Hard Sci-Fi & Space Realism" },
        { "type": "movie", "id": "cat_masterpieces", "name": "🏆 Modern Masterpieces (8.0+)" },
        { "type": "movie", "id": "cat_dark_noir", "name": "🌪️ Dark Neo-Noir & Gritty Crime" },
        { "type": "movie", "id": "cat_timeloop_reality", "name": "⏳ Non-Linear & Alternate Realities" },
        { "type": "movie", "id": "cat_director_vision", "name": "🎬 Visionary Auteur Cinema" },
        { "type": "movie", "id": "cat_smart_wildcard", "name": "🎲 Smart Taste Wildcard" },
        { "type": "series", "id": "cat_prestige_series", "name": "📺 Prestige Miniseries & Drama" }
    ],
    "idPrefixes": ["tt"]
};

const builder = new addonBuilder(manifest);

// High-grade fallback seeds
const FALLBACK_FAVORITES = ["tt1375666", "tt0816692", "tt0468569", "tt0110912", "tt0137523", "tt0111161", "tt0062622", "tt2096673"];

// Cache scraped IDs briefly in-memory to keep serverless responses fast
let cachedRatedIds = null;
let lastFetch = 0;

async function getRatedImdbIds(userId) {
    const now = Date.now();
    if (cachedRatedIds && (now - lastFetch < 1000 * 60 * 30)) {
        return cachedRatedIds;
    }

    try {
        const url = `https://www.imdb.com/user/${userId}/ratings/`;
        const { data } = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9"
            },
            timeout: 4500
        });

        const $ = cheerio.load(data);
        const ids = [];
        $('a[href*="/title/tt"]').each((_, el) => {
            const href = $(el).attr("href");
            const match = href ? href.match(/tt\d{7,8}/) : null;
            if (match && !ids.includes(match[0])) ids.push(match[0]);
        });

        cachedRatedIds = ids.length > 0 ? ids : FALLBACK_FAVORITES;
        lastFetch = now;
        return cachedRatedIds;
    } catch {
        return FALLBACK_FAVORITES;
    }
}

// Convert TMDB discover results into Stremio metas with IMDb IDs
async function resolveToStremioMetas(results, isSeries = false, limit = 18) {
    const metas = [];
    const sliced = results.slice(0, limit);

    for (const item of sliced) {
        try {
            const endpoint = isSeries ? "tv" : "movie";
            const extRes = await axios.get(
                `https://api.themoviedb.org/3/${endpoint}/${item.id}/external_ids?api_key=${TMDB_API_KEY}`,
                { timeout: 2000 }
            );
            const imdbId = extRes.data.imdb_id;
            if (!imdbId) continue;

            metas.push({
                id: imdbId,
                type: isSeries ? "series" : "movie",
                name: isSeries ? item.name : item.title,
                poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
                description: item.overview,
                releaseInfo: (item.release_date || item.first_air_date || "").split("-")[0]
            });
        } catch {
            // Drop cleanly if external ID lookup fails
        }
    }
    return metas;
}

builder.defineCatalogHandler(async ({ type, id }) => {
    try {
        const ratedIds = await getRatedImdbIds(IMDB_PROFILE_ID);
        const ratedSet = new Set(ratedIds);

        let queryUrl = "";
        let isSeries = (type === "series");

        // --- CATALOG ROUTING BY DISCOVER QUERIES ---

        if (id === "cat_mind_bending") {
            // Sci-Fi (878) + Mystery (9648), high ratings, good vote volume
            queryUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=878,9648&vote_average.gte=7.3&vote_count.gte=800&sort_by=vote_average.desc`;
        } 
        else if (id === "cat_psych_thriller") {
            // Thriller (53) + Mystery (9648) or Crime (80)
            queryUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=53,9648&without_genres=28,12&vote_average.gte=7.4&vote_count.gte=1000&sort_by=vote_average.desc`;
        } 
        else if (id === "cat_hidden_gems") {
            // High score (7.5 - 8.6), moderate vote count (300 - 4500) to filter out blockbusters
            queryUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&vote_average.gte=7.5&vote_count.gte=300&vote_count.lte=4500&sort_by=vote_average.desc`;
        } 
        else if (id === "cat_space_scifi") {
            // Sci-Fi (878), keywords around space/astronautics/speculative
            queryUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=878&with_keywords=9882|3801|161176|14901&vote_average.gte=7.2&vote_count.gte=500&sort_by=vote_average.desc`;
        } 
        else if (id === "cat_masterpieces") {
            // Universally acclaimed across drama, crime, and sci-fi
            queryUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&vote_average.gte=8.1&vote_count.gte=2500&sort_by=vote_average.desc`;
        } 
        else if (id === "cat_dark_noir") {
            // Crime (80) + Thriller (53)
            queryUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=80,53&vote_average.gte=7.4&vote_count.gte=800&sort_by=popularity.desc`;
        } 
        else if (id === "cat_timeloop_reality") {
            // Sci-Fi or Fantasy dealing with time distortion, parallel worlds
            queryUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=878&with_keywords=4379|1930|9882&vote_average.gte=7.0&vote_count.gte=400&sort_by=vote_average.desc`;
        } 
        else if (id === "cat_director_vision") {
            // Deep dive on modern auteur cinema (Nolan, Denis Villeneuve, Fincher, Kubrick style pool)
            queryUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_people=525|137427|7467|240|5655&vote_average.gte=7.6&sort_by=vote_average.desc`;
        } 
        else if (id === "cat_smart_wildcard") {
            // Randomized page offset (1-5) on top-tier thriller/sci-fi to keep it dynamic every refresh
            const randomPage = Math.floor(Math.random() * 5) + 1;
            queryUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=878|53|9648&vote_average.gte=7.5&vote_count.gte=1200&page=${randomPage}&sort_by=vote_average.desc`;
        } 
        else if (id === "cat_prestige_series") {
            // High-rating TV miniseries / drama
            queryUrl = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&with_genres=18,9648&vote_average.gte=8.0&vote_count.gte=400&sort_by=vote_average.desc`;
        }

        if (!queryUrl) return { metas: [] };

        const { data } = await axios.get(queryUrl, { timeout: 3500 });
        const rawResults = data.results || [];

        // Exclude titles you have already rated on IMDb
        const unratedCandidates = rawResults.filter(item => !ratedSet.has(item.id));

        const metas = await resolveToStremioMetas(unratedCandidates, isSeries, 18);
        return { metas };

    } catch (err) {
        console.error(`Catalog error on ${id}:`, err.message);
        return { metas: [] };
    }
});

const router = getRouter(builder.getInterface());

module.exports = (req, res) => {
    router(req, res, (err) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.status(404).send("Not Found");
        }
    });
};
