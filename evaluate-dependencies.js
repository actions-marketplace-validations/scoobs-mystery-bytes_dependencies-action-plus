const core = require('@actions/core');
const github = require('@actions/github');

var customDomains = core.getInput('custom-domains')?.split(/(\s+)/) ?? [];

const keyPhrases = 'depends on|blocked by';
const issueTypes = 'issues|pull';
const domainsList = ['github.com'].concat(customDomains); // add others from parameter
const domainsString = combineDomains(domainsList);

const quickLinkRegex = new RegExp(`(${keyPhrases}):? #(\\d+)`, 'gmi');
const partialLinkRegex = new RegExp(`(${keyPhrases}):? ([-_\\w]+)\\/([-._a-z0-9]+)(#)(\\d+)`, 'gmi');
const partialUrlRegex = new RegExp(`(${keyPhrases}):? ([-_\\w]+)\\/([-._a-z0-9]+)\\/(${issueTypes})\\/(\\d+)`, 'gmi');
const fullUrlRegex = new RegExp(`(${keyPhrases}):? https?:\\/\\/(?:${domainsString})\\/([-_\\w]+)\\/([-._a-z0-9]+)\\/(${issueTypes})\\/(\\d+)`, 'gmi');
const markdownRegex = new RegExp(`(${keyPhrases}):? \\[.*\\]\\(https?:\\/\\/(?:${domainsString})\\/([-_\\w]+)\\/([-._a-z0-9]+)\\/(${issueTypes})\\/(\\d+)\\)`, 'gmi');
const statusMarker = '<!-- pr-dependencies -->';
const missingDependencyMessage = 'No dependencies found. Add at least one pull request dependency using "Depends on #123" or "Blocked by #123" in the PR description or a discussion comment.';

function withoutStatus(body) {
    const start = body.indexOf(statusMarker);
    return start === -1 ? body : body.slice(0, start);
}

function formatStatus(dependencies) {
    const reference = dependency => {
        const sameRepo = dependency.owner.toLowerCase() === github.context.repo.owner.toLowerCase() &&
            dependency.repo.toLowerCase() === github.context.repo.repo.toLowerCase();
        return `${sameRepo ? '' : `${dependency.owner}/${dependency.repo}`}#${dependency.pull_number}`;
    };
    const escapeTitle = title => title.replace(/\s+/g, ' ').replace(/[\\`*_{}\[\]<>()|!]/g, '\\$&');
    const waiting = dependencies.filter(item => !item.resolved);
    const notice = dependencies.length === 0
        ? `> [!WARNING]\n> **Dependency required.** ${missingDependencyMessage}`
        : waiting.length
        ? `> [!WARNING]\n> **Waiting on ${waiting.length} ${waiting.length === 1 ? 'dependency' : 'dependencies'}.** Merge ${waiting.map(item => reference(item.dependency)).join(', ')} before merging this PR.`
        : '> [!TIP]\n> **All dependencies merged.** This PR is clear of dependency blockers.';
    const rows = dependencies.map(({ dependency, title, state }) =>
        `| ${reference(dependency)} — ${escapeTitle(title)} | ${state} |`);
    const table = dependencies.length
        ? `\n\n| Dependency | Status |\n| :--- | :--- |\n${rows.join('\n')}`
        : '';
    const now = new Date();
    const date = now.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
    const time = now.toISOString().slice(11, 16);
    return `${statusMarker}\n\n### 🔗 Pull request dependencies\n\n${notice}${table}\n\n<details>\n<summary>How dependencies are checked</summary>\n\nDependencies are refreshed automatically when this workflow runs.\nOnly merged pull requests count as resolved.\n\n</details>\n\n---\n_Last checked: ${date} · ${time} UTC_`;
}

function escapeDomainForRegex(domain) {
    return domain.replace('.', '\\.');
}

function combineDomains(domains) {
    return domains.map(x => escapeDomainForRegex(x)).join("|");
}

function extractFromMatch(match) {
    return {
        owner: match[2],
        repo: match[3],
        pull_number: parseInt(match[5], 10)
    };
}

function getAllDependencies(body) {
    var allMatches = [];

    var quickLinkMatches = [...body.matchAll(quickLinkRegex)];
    if (quickLinkMatches.length !== 0) {
        quickLinkMatches.forEach(match => {
            core.info(`  Found number-referenced dependency in '${match}'`);
            allMatches.push({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: parseInt(match[2], 10)
            });
        });
    }
    
    var extractableMatches = [...body.matchAll(partialLinkRegex)]
        .concat([...body.matchAll(partialUrlRegex)])
        .concat([...body.matchAll(fullUrlRegex)])
        .concat([...body.matchAll(markdownRegex)]);
    if (extractableMatches.length !== 0) {
        extractableMatches.forEach(match => {
            core.info(`  Found number-referenced dependency in '${match}'`);
            allMatches.push(extractFromMatch(match));
        });
    }

    return allMatches;
}

async function evaluate() {
    try {
        core.info('Initializing...');
        const myToken = process.env.GITHUB_TOKEN;
        const octokit = github.getOctokit(myToken);

        const { data: pullRequest } = await octokit.pulls.get({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            pull_number: github.context.issue.number,
        });

        const commentParams = {
            ...github.context.repo,
            issue_number: github.context.issue.number,
        };
        const comments = await octokit.paginate(octokit.issues.listComments, {
            ...commentParams,
            per_page: 100,
        });
        let dependencyComment = comments.find(comment => comment.body?.includes(statusMarker));
        let dependencies = [];
        for (const comment of comments) {
            const found = getAllDependencies(withoutStatus(comment.body || ''));
            if (found.length !== 0) {
                dependencyComment = dependencyComment || comment;
                dependencies = found;
                break;
            }
        }
        if (dependencies.length === 0) {
            core.info('\nReading PR body...');
            dependencies = getAllDependencies(pullRequest.body || '');
        }
        dependencies = dependencies.filter((dependency, index, all) =>
            all.findIndex(other => other.owner.toLowerCase() === dependency.owner.toLowerCase() &&
                other.repo.toLowerCase() === dependency.repo.toLowerCase() &&
                other.pull_number === dependency.pull_number) === index);

        core.info('\nAnalyzing lines...');
        var dependencyIssues = [];
        const statuses = [];
        for (var d of dependencies) {
            const status = { dependency: d, resolved: false, title: 'Could not be located', state: '❓ Unknown' };
            statuses.push(status);
            core.info(`  Fetching '${JSON.stringify(d)}'`);
            var isPr = true;
            var response = await octokit.pulls.get(d).catch(error => core.error(error));
            if (response === undefined) {
                isPr = false;
                d = {
                    owner: d.owner,
                    repo: d.repo,
                    issue_number: d.pull_number,
                };
                core.info(`  Fetching '${JSON.stringify(d)}'`);
                response = await octokit.issues.get(d).catch(error => core.error(error));
                if (response === undefined) {
                    core.info('    Could not locate this dependency.  Treating as unresolved.');
                    dependencyIssues.push({ number: d.issue_number, title: `Unknown (in ${d.owner}/${d.repo} - could not be located)` });
                    continue;
                }
            }
            if (isPr) {
                const { data: pr } = response;
                if (!pr) continue;
                status.title = pr.title;
                if (!pr.merged) {
                    status.state = pr.closed_at ? '❌ Closed without merging' : '⏳ Open';
                    core.info('    PR has not been merged.');
                    dependencyIssues.push(pr);
                } else {
                    status.resolved = true;
                    status.state = '✅ Merged';
                    core.info('    PR has been merged.');
                }
            } else {
                const { data: issue } = response;
                if (!issue) continue;
                status.title = issue.title;
                status.state = '⚠️ Issue (requires a pull request)';
                dependencyIssues.push(issue);
            }
        }

        if (dependencyComment) {
            const original = withoutStatus(dependencyComment.body || '').trimEnd();
            const body = `${original ? `${original}\n\n` : ''}${formatStatus(statuses)}`;
            if (body !== dependencyComment.body) {
                await octokit.issues.updateComment({
                    ...github.context.repo,
                    comment_id: dependencyComment.id,
                    body,
                });
            }
        } else {
            await octokit.issues.createComment({
                ...commentParams,
                body: formatStatus(statuses),
            });
        }

        if (dependencies.length === 0) {
            core.setFailed(missingDependencyMessage);
        } else if (dependencyIssues.length !== 0) {
            var msg = '\nThe following issues need to be resolved before this PR can be merged:\n';
            for (var pr of dependencyIssues) {
                msg += `\n#${pr.number} - ${pr.title}`;
            }
            core.setFailed(msg);
        } else {
            core.info("\nAll dependencies have been resolved!")
        }
    } catch (error) {
        core.setFailed(error.message);
        throw error;
    }
}

module.exports = {
    evaluate: evaluate,
    getAllDependencies: getAllDependencies
}
