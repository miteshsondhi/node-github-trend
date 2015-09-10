import * as request from "request";
import * as cheerio from "cheerio";
import * as yaml from "js-yaml";

interface RepositoryEntry {
    owner: string;
    name: string;
}

interface Repository {
    [param: string]: any;
}

interface Repositories {
    [lang: string]: Repository[];
}

interface ScraperConfig {
    proxy?: string;
}

interface Language {
    color: string;
    aliases? : string[];
}

const RE_HREF_SCRAPE = /^\/([^\/]+)\/([^\/]+)$/;

export class Scraper {
    config: ScraperConfig;
    cache: Object;

    constructor(config?: ScraperConfig) {
        this.config = config || {};
        this.cache = null;
    }

    fetchTrendPage(lang_name: string) {
        let opts: request.Options = {
            url: "https://github.com/trending"
        };

        if (lang_name) {
            opts.url += "?l=" + lang_name;
        }

        if (this.config.proxy) {
            opts.proxy = this.config.proxy;
        }

        return new Promise((resolve, reject) => {
            request(opts, (err, res, body) => {
                if (err) {
                    reject(err);
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error("Invalid status: " + res.statusCode));
                    return;
                }

                resolve(body);
            });
        });
    }

    scrapeTrendingRepos(lang_name: string) {
        return this.fetchTrendPage(lang_name).then((html: string) => {
            const dom = cheerio.load(html);
            return dom(".repo-list-item .repo-list-name a")
                            .toArray()
                            .map((a: any) => {
                                const href: string = a.attribs["href"];
                                const match = href.match(RE_HREF_SCRAPE)
                                if (!match) {
                                    console.log("Invalid repo: " + href);
                                }
                                return {
                                    owner: match[1],
                                    name: match[2],
                                };
                            });
        });
    }

    fetchLanguageYAML() {
        if (this.cache !== null) {
            return Promise.resolve(this.cache);
        }

        return new Promise((resolve, reject) => {
            let opts: request.Options = {
                url: "https://raw.githubusercontent.com/github/linguist/master/lib/linguist/languages.yml"
            };

            if (this.config.proxy) {
                opts.proxy = this.config.proxy;
            }

            request(opts, (err, res, body) => {
                if (err) {
                    reject(err);
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error("Invalid status: " + res.statusCode));
                    return;
                }

                const langs = yaml.safeLoad(body);
                this.cache = langs
                resolve(langs);
            });
        });
    }

    scrapeLanguageColors() {
        return this.fetchLanguageYAML().then((langs: any) => {
            let result: any = {};
            for (const name in langs) {
                const lang: Language = langs[name];
                if (!lang.color) {
                    continue;
                }

                result[name.toLowerCase()] = lang.color;
                if (lang.aliases !== undefined) {
                    for (const alias of lang.aliases) {
                        result[alias.toLowerCase()] = lang.color;
                    }
                }
            }
            return result;
        });
    }

    scrapeLanguageNames() {
        return this.fetchLanguageYAML().then((langs: any) => {
            let result: string[] = [];
            for (const name in langs) {
                result.push(name);
                const lang: Language = langs[name];
                if (!lang.color) {
                    continue;
                }

                if (lang.aliases !== undefined) {
                    Array.prototype.push.apply(result, lang.aliases);
                }
            }
            return result;
        });
    }
}

export class Client {
    scraper: Scraper;

    constructor(config?: ScraperConfig) {
        this.scraper = new Scraper(config);
    }

    fetchGetAPI(repo: RepositoryEntry) {
        return new Promise((resolve, reject) => {
            let opts: request.Options = {
                url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
                headers: {
                    "User-Agent": "request",
                    "Accept" : "application/vnd.github.v3+json"
                }
            };

            if (this.scraper.config.proxy) {
                opts.proxy = this.scraper.config.proxy;
            }

            request(opts, (err, res, body) => {

                if (err) {
                    reject(err);
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error("Invalid status: " + res.statusCode));
                    return;
                }

                resolve(JSON.parse(body));
            });
        });
    }

    fetchTrending(lang: string) {
        return this.scraper.scrapeTrendingRepos(lang).then((repos: RepositoryEntry[]) => {
            let promises: Promise<Repository>[] = [];
            for (const repo of repos) {
                promises.push(this.fetchGetAPI(repo));
            }
            return Promise.all(promises);
        });
    }

    fetchAppendingReadme(repo: {[key: string]: any}) {
        return new Promise(resolve => {
            const readme_url = repo['html_url'] + '/README.md';
            let opts: request.Options = {
                url: readme_url,
                method: 'HEAD',
            }

            if (this.scraper.config.proxy) {
                opts.proxy = this.scraper.config.proxy;
            }

            request(opts, (err, res, _) => {
                if (err) {
                    resolve(repo);
                    return;
                }

                if (res.statusCode !== 200) {
                    console.log(JSON.stringify(res));
                    resolve(repo);
                }

                repo['readme_url'] = readme_url;
                resolve(repo);
            });
        });
    }

    fetchTrendingWithReadme(lang: string) {
        return this.fetchTrending(lang).then((repos: Repository[]) => {
            let promises: Promise<Repository[]>[] = [];
            for (const repo of repos) {
                promises.push(this.fetchAppendingReadme(repo));
            }
            return Promise.all(promises);
        });
    }

    fetchTrendings(langs: string[]) {
        let promises: Promise<Repository[]>[] = [];

        for (const lang of langs) {
            promises.push(this.fetchTrending(lang));
        }

        return Promise.all(promises)
                      .then((trendings: Repository[][]) => {
                          let result: Repositories = {};
                          for (const idx in langs) {
                              result[langs[idx]] = trendings[idx];
                          }
                          return result;
                      });
    }
}
