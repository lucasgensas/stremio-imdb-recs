const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const TMDB_API_KEY = "d659c9a6006168cfeee99cd51cad6623";
const IMDB_PROFILE_ID = "p.k7ky5tvxj7vurvtblpjto6ck2a";

const manifest = {
    "id": "org.myself.imdb.smart.recs",
    "version": "1.0.0",
    "name": "IMDb Dynamic Picks",
    "description": "Dynamic recommendations generated from your public IMDb profile ratings",
    "resources": ["catalog"],
    "types": ["movie"],
    "catalogs": [
        {
            "type": "movie",
            "id": "imdb_dynamic_recs",
            "name": "🎯 For You: IMDb Recommendations"
        }
    ],
    "idPrefixes": ["tt"]
};

const builder = new addonBuilder(manifest);

// Fallback seeds if scraping hits temporary rate limiting
const FALLBACK_SEEDS = ["tt1375666", "tt0816692", "tt0468569", "tt0110912"];

async function fetchImdbRatings(userId) {
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
        const ratedIds = [];

        // Match IMDb IDs from anchor tags
        $('a[href*="/title/tt"]').each((_, el) => {
            const href = $(el).attr("href");
            const match = href ? href.match(/tt\d{7,8}/) : null;
            if (match && !ratedIds.includes(match[0])) {
                ratedIds.push(match[0]);
            }
        });

        return ratedIds.length > 0 ? ratedIds : FALLBACK_SEEDS;
    } catch (err) {
        console.warn("IMDb fetch failed, using fallback seeds:", err.message);
        return FALLBACK_SEEDS;
    }
}

builder.defineCatalogHandler(async ({ type, id }) => {
    if (type !== "movie" || id !== "imdb_dynamic_recs") {
        return { metas: [] };
    }

    try {
        const ratedIds = await fetchImdbRatings(IMDB_PROFILE_ID);

        // Pick 2 random seeds from your ratings list
        const shuffled = [...ratedIds].sort(() => 0.5 - Math.random());
        const selectedSeeds = shuffled.slice(0, 2);

        const candidateMovies = [];
        const seenTmdbIds = new Set();

        for (const imdbId of selectedSeeds) {
            try {
                // Find TMDB ID from IMDb ID
                const findRes = await axios.get(
                    `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
                    { timeout: 3000 }
                );
                const tmdbMovie = findRes.data.movie_results?.[0];
                if (!tmdbMovie) continue;

                // Request recommendations from TMDB
                const recsRes = await axios.get(
                    `https://api.themoviedb.org/3/movie/${tmdbMovie.id}/recommendations?api_key=${TMDB_API_KEY}`,
                    { timeout: 3000 }
                );

                for (const item of recsRes.data.results || []) {
                    if (!seenTmdbIds.has(item.id)) {
                        seenTmdbIds.add(item.id);
                        candidateMovies.push(item);
                    }
                }
            } catch (seedErr) {
                console.error(`Error querying TMDB for seed ${imdbId}:`, seedErr.message);
            }
        }

        // Shuffle candidate list and map to Stremio meta objects
        const metas = candidateMovies
            .sort(() => 0.5 - Math.random())
            .slice(0, 25)
            .map(movie => ({
                id: `tmdb:${movie.id}`,
                type: "movie",
                name: movie.title,
                poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                description: movie.overview,
                releaseInfo: movie.release_date ? movie.release_date.split("-")[0] : ""
            }));

        return { metas };
    } catch (err) {
        console.error("Catalog generation error:", err.message);
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
