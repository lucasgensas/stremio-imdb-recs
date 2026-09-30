const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const TMDB_API_KEY = "d659c9a6006168cfeee99cd51cad6623";
const IMDB_PROFILE_ID = "p.k7ky5tvxj7vurvtblpjto6ck2a";

// Manifest with 4 distinct catalog rows
const manifest = {
    "id": "org.myself.imdb.multi.picks",
    "version": "1.2.0",
    "name": "IMDb Dynamic Multi-Curator",
    "description": "Dynamic, personalized multi-catalog recommendations tailored to your taste",
    "resources": ["catalog"],
    "types": ["movie"],
    "catalogs": [
        {
            "type": "movie",
            "id": "recs_seed_1",
            "name": "🎬 Spotlight Pick A"
        },
        {
            "type": "movie",
            "id": "recs_seed_2",
            "name": "🍿 Spotlight Pick B"
        },
        {
            "type": "movie",
            "id": "recs_high_rated",
            "name": "💎 High-Rated Taste Matches"
        },
        {
            "type": "movie",
            "id": "recs_wildcard",
            "name": "🎲 Dynamic Wildcard"
        }
    ],
    "idPrefixes": ["tt"]
};

const builder = new addonBuilder(manifest);

// High-grade fallback seeds in case of transient IMDb rate limits
const FALLBACK_SEEDS = [
    { imdbId: "tt1375666", title: "Inception" },
    { imdbId: "tt0816692", title: "Interstellar" },
    { imdbId: "tt0468569", title: "The Dark Knight" },
    { imdbId: "tt0110912", title: "Pulp Fiction" },
    { imdbId: "tt0137523", title: "Fight Club" },
    { imdbId: "tt0111161", title: "The Shawshank Redemption" }
];

// Helper: Scrape ratings from IMDb profile
async function fetchImdbRatedTitles(userId) {
    try {
        const url = `https://www.imdb.com/user/${userId}/ratings/`;
        const { data } = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9"
            },
            timeout: 5000
        });

        const $ = cheerio.load(data);
        const ratedItems = [];
        const seen = new Set();

        $('a[href*="/title/tt"]').each((_, el) => {
            const href = $(el).attr("href");
            const match = href ? href.match(/tt\d{7,8}/) : null;
            const text = $(el).text().trim();
            if (match && !seen.has(match[0])) {
                seen.add(match[0]);
                ratedItems.push({ imdbId: match[0], title: text || "your rated film" });
            }
        });

        return ratedItems.length > 0 ? ratedItems : FALLBACK_SEEDS;
    } catch (err) {
        console.warn("IMDb fetch fallback:", err.message);
        return FALLBACK_SEEDS;
    }
}

// Helper: Get TMDB movie details and recommendations
async function getTmdbRecs(imdbId) {
    try {
        const findRes = await axios.get(
            `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
            { timeout: 3500 }
        );
        const tmdbMovie = findRes.data.movie_results?.[0];
        if (!tmdbMovie) return { seedTitle: "", recs: [] };

        const recsRes = await axios.get(
            `https://api.themoviedb.org/3/movie/${tmdbMovie.id}/recommendations?api_key=${TMDB_API_KEY}`,
            { timeout: 3500 }
        );

        return {
            seedTitle: tmdbMovie.title,
            recs: recsRes.data.results || []
        };
    } catch (e) {
        return { seedTitle: "", recs: [] };
    }
}

// Helper: Resolve TMDB items to IMDb IDs for native Stremio compatibility
async function formatMetas(tmdbMovies, limit = 20) {
    const selected = tmdbMovies.slice(0, limit);
    const metas = [];

    for (const movie of selected) {
        try {
            // Get external IDs to retrieve the IMDb ID (tt...)
            const extRes = await axios.get(
                `https://api.themoviedb.org/3/movie/${movie.id}/external_ids?api_key=${TMDB_API_KEY}`,
                { timeout: 2500 }
            );
            const imdbId = extRes.data.imdb_id;
            if (!imdbId) continue;

            metas.push({
                id: imdbId,
                type: "movie",
                name: movie.title,
                poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                description: movie.overview,
                releaseInfo: movie.release_date ? movie.release_date.split("-")[0] : ""
            });
        } catch {
            // Skip item if external ID lookup drops
        }
    }
    return metas;
}

builder.defineCatalogHandler(async ({ type, id }) => {
    if (type !== "movie") return { metas: [] };

    try {
        const ratedList = await fetchImdbRatedTitles(IMDB_PROFILE_ID);
        const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

        // --- CATALOG 1: Spotlight Seed A ---
        if (id === "recs_seed_1") {
            const seed = randomItem(ratedList);
            const { recs } = await getTmdbRecs(seed.imdbId);
            const metas = await formatMetas(recs, 15);
            return { metas };
        }

        // --- CATALOG 2: Spotlight Seed B ---
        if (id === "recs_seed_2") {
            const seed = randomItem(ratedList);
            const { recs } = await getTmdbRecs(seed.imdbId);
            const metas = await formatMetas(recs, 15);
            return { metas };
        }

        // --- CATALOG 3: High-Rated Matches (Score >= 7.5) ---
        if (id === "recs_high_rated") {
            const seed = randomItem(ratedList);
            const { recs } = await getTmdbRecs(seed.imdbId);
            const highRated = recs.filter(m => (m.vote_average || 0) >= 7.5);
            const metas = await formatMetas(highRated.length >= 5 ? highRated : recs, 15);
            return { metas };
        }

        // --- CATALOG 4: Dynamic Wildcard (Combined Pool) ---
        if (id === "recs_wildcard") {
            const seedA = randomItem(ratedList);
            const seedB = randomItem(ratedList);
            const [resA, resB] = await Promise.all([
                getTmdbRecs(seedA.imdbId),
                getTmdbRecs(seedB.imdbId)
            ]);
            const combined = [...resA.recs, ...resB.recs].sort(() => 0.5 - Math.random());
            const metas = await formatMetas(combined, 15);
            return { metas };
        }

        return { metas: [] };
    } catch (err) {
        console.error("Catalog Handler Error:", err.message);
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
