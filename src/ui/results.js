import { clusterArtists } from '../core/cluster.js';

export function createResults(container) {
  let total = 0;
  let completed = [];
  let section = null;
  let clustersListEl = null;
  let progressEl = null;
  let finalized = false;

  function clear() {
    total = 0;
    completed = [];
    section = null;
    clustersListEl = null;
    progressEl = null;
    finalized = false;
    container.replaceChildren();
  }

  function start(artistNames) {
    clear();
    total = artistNames.length;

    section = document.createElement('section');
    section.className = 'clusters';

    const h2 = document.createElement('h2');
    h2.textContent = 'Same act, different names';
    section.append(h2);

    const hint = document.createElement('p');
    hint.className = 'clusters-hint';
    hint.textContent =
      'Matches will appear here as artists are looked up. Groupings may combine as more data arrives.';
    section.append(hint);

    clustersListEl = document.createElement('div');
    clustersListEl.className = 'clusters-list';
    section.append(clustersListEl);

    progressEl = document.createElement('p');
    progressEl.className = 'clusters-progress';
    progressEl.textContent = `0 of ${total} artists checked…`;
    section.append(progressEl);

    container.append(section);
  }

  function onArtistDone() {
    // No-op: per-artist cards are not rendered during processing. The
    // callback is kept so `lookupAll` can continue to call it without error.
  }

  function onArtistComplete(artistName, _merged, { queried = [], errored = [], closure } = {}) {
    if (finalized) return;
    completed.push({
      name: artistName,
      closure: closure ?? new Set(),
      fullyErrored: queried.length === 0 && errored.length > 0,
    });
    rerenderClusters();
    updateProgress();
  }

  function rerenderClusters() {
    const { clusters } = clusterArtists(completed);
    renderClusterList(clusters);
  }

  function updateProgress() {
    if (!progressEl) return;
    progressEl.textContent = `${completed.length} of ${total} artists checked…`;
  }

  function finalize() {
    if (finalized) return;
    finalized = true;

    const { clusters, singletons } = clusterArtists(completed);
    renderClusterList(clusters);

    if (progressEl) {
      progressEl.remove();
      progressEl = null;
    }

    if (singletons.length) {
      const singletonsSection = document.createElement('section');
      singletonsSection.className = 'singletons';
      const h2 = document.createElement('h2');
      h2.textContent = 'No aliases on the lineup';
      singletonsSection.append(h2);
      const ul = document.createElement('ul');
      for (const { name } of singletons) {
        const li = document.createElement('li');
        li.textContent = name;
        ul.append(li);
      }
      singletonsSection.append(ul);
      container.append(singletonsSection);
    }

    const failed = completed.filter((c) => c.fullyErrored);
    if (failed.length) {
      const banner = document.createElement('p');
      banner.className = 'errored-banner';
      const names = failed.map((c) => c.name).join(', ');
      const word = failed.length === 1 ? 'artist' : 'artists';
      banner.textContent = `${failed.length} ${word} couldn’t be checked: ${names}`;
      container.append(banner);
    }

    if (!clusters.length && !singletons.length) {
      const empty = document.createElement('p');
      empty.className = 'results-empty';
      empty.textContent = 'No results.';
      container.append(empty);
    }
  }

  function renderClusterList(clusters) {
    if (!clustersListEl) return;
    clustersListEl.replaceChildren();
    for (const cluster of clusters) {
      const article = document.createElement('article');
      article.className = 'cluster';
      const ul = document.createElement('ul');
      for (const name of cluster.names) {
        const li = document.createElement('li');
        li.textContent = name;
        ul.append(li);
      }
      article.append(ul);
      clustersListEl.append(article);
    }
  }

  return { start, onArtistDone, onArtistComplete, finalize, clear };
}
