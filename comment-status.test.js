jest.mock('@actions/core', () => ({
    getInput: jest.fn(() => ''),
    info: jest.fn(),
    error: jest.fn(),
    setFailed: jest.fn(),
}));
jest.mock('@actions/github', () => ({
    context: { repo: { owner: 'owner', repo: 'repo' }, issue: { number: 200 } },
    getOctokit: jest.fn(),
}));

const core = require('@actions/core');
const github = require('@actions/github');
const { evaluate } = require('./evaluate-dependencies');

let octokit;
let body;
let comments;
let pulls;

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-11-03T14:32:00Z'));
    body = 'Depends on #139\nBlocked by #142';
    comments = [];
    pulls = {
        139: { number: 139, title: 'Add database schema', merged: true },
        142: { number: 142, title: 'Update API response', merged: false, closed_at: null },
    };
    octokit = {
        paginate: jest.fn(async () => comments),
        pulls: { get: jest.fn(async ({ pull_number }) => {
            if (pull_number === 200) return { data: { body } };
            if (!pulls[pull_number]) throw new Error('Not Found');
            return { data: pulls[pull_number] };
        }) },
        issues: {
            listComments: jest.fn(),
            get: jest.fn().mockRejectedValue(new Error('Not Found')),
            createComment: jest.fn(),
            updateComment: jest.fn(),
        },
    };
    github.getOctokit.mockReturnValue(octokit);
});

afterEach(() => jest.useRealTimers());

test('creates the requested warning table from description dependencies', async () => {
    await evaluate();
    expect(octokit.paginate).toHaveBeenCalledWith(octokit.issues.listComments, {
        owner: 'owner', repo: 'repo', issue_number: 200, per_page: 100,
    });
    expect(octokit.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner', repo: 'repo', issue_number: 200,
        body: `<!-- pr-dependencies -->

### 🔗 Pull request dependencies

> [!WARNING]
> **Waiting on 1 dependency.** Merge #142 before merging this PR.

| Dependency | Status |
| :--- | :--- |
| #139 — Add database schema | ✅ Merged |
| #142 — Update API response | ⏳ Open |

<details>
<summary>How dependencies are checked</summary>

Dependencies are refreshed automatically when this workflow runs.
Only merged pull requests count as resolved.

</details>

---
_Last checked: Nov 3, 2026 · 14:32 UTC_`,
    });
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('#142 - Update API response'));
});

test('formats a dependency discussion comment even when the description is empty', async () => {
    body = null;
    comments = [{ id: 9, body: 'Some context\nDepends on #139' }];
    await evaluate();
    expect(octokit.issues.updateComment).toHaveBeenCalledWith({
        owner: 'owner', repo: 'repo', comment_id: 9,
        body: expect.stringContaining('Some context\nDepends on #139\n\n<!-- pr-dependencies -->'),
    });
    expect(octokit.issues.updateComment.mock.calls[0][0].body).toContain(
        '> [!TIP]\n> **All dependencies merged.** This PR is clear of dependency blockers.');
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
});

test('discussion dependencies take precedence over the description', async () => {
    comments = [{ id: 9, body: 'Depends on #139' }];
    await evaluate();
    expect(octokit.pulls.get).not.toHaveBeenCalledWith(expect.objectContaining({ pull_number: 142 }));
    expect(core.setFailed).not.toHaveBeenCalled();
});

test('reuses a marked comment and switches the warning to a tip after merging', async () => {
    await evaluate();
    comments = [{ id: 10, body: octokit.issues.createComment.mock.calls[0][0].body }];
    pulls[142].merged = true;
    jest.clearAllMocks();
    await evaluate();
    const updated = octokit.issues.updateComment.mock.calls[0][0];
    expect(updated.comment_id).toBe(10);
    expect(updated.body).toContain('> [!TIP]');
    expect(updated.body).not.toContain('[!WARNING]');
    expect(updated.body.match(/<!-- pr-dependencies -->/g)).toHaveLength(1);
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
});

test('prefers the marked status comment over creating another formatted comment', async () => {
    comments = [
        { id: 9, body: 'Depends on #139' },
        { id: 10, body: '<!-- pr-dependencies -->\nOld status' },
    ];
    await evaluate();
    expect(octokit.issues.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 10 }));
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
});

test('does not rewrite an unchanged formatted comment', async () => {
    comments = [{ id: 9, body: 'Depends on #139' }];
    await evaluate();
    comments[0].body = octokit.issues.updateComment.mock.calls[0][0].body;
    jest.clearAllMocks();
    await evaluate();
    expect(octokit.issues.updateComment).not.toHaveBeenCalled();
});

test('closed but unmerged pull requests remain blockers', async () => {
    pulls[142].closed_at = '2026-11-03T12:00:00Z';
    await evaluate();
    expect(octokit.issues.createComment.mock.calls[0][0].body).toContain('❌ Closed without merging');
    expect(core.setFailed).toHaveBeenCalled();
});

test('closed issues do not count as merged pull requests', async () => {
    delete pulls[142];
    octokit.issues.get.mockResolvedValue({
        data: { number: 142, title: 'An issue', closed_at: '2026-11-03T12:00:00Z' },
    });
    await evaluate();
    expect(octokit.issues.createComment.mock.calls[0][0].body).toContain('⚠️ Issue (requires a pull request)');
    expect(core.setFailed).toHaveBeenCalled();
});

test('missing dependencies remain visible and unresolved', async () => {
    delete pulls[142];
    await evaluate();
    expect(octokit.issues.createComment.mock.calls[0][0].body).toContain('| #142 — Could not be located | ❓ Unknown |');
    expect(core.setFailed).toHaveBeenCalled();
});

test('deduplicates dependencies and escapes titles in table rows', async () => {
    body = 'Depends on #139\nDepends on owner/repo#139\nDepends on other/repo#142';
    pulls[139].title = 'Add | schema\nwith **formatting**';
    await evaluate();
    const result = octokit.issues.createComment.mock.calls[0][0].body;
    expect(result).toContain('Add \\| schema with \\*\\*formatting\\*\\*');
    expect(result).toContain('other/repo#142');
    expect(octokit.pulls.get).toHaveBeenCalledTimes(3);
});

test.each([null, '', 'Update documentation', 'Depends on', 'Blocked by none'])(
    'fails and explains the requirement when no dependencies exist: %p', async (description) => {
    body = description;
    comments = [{ id: 9, body: 'Looks good!' }];
    await evaluate();
    const status = octokit.issues.createComment.mock.calls[0][0].body;
    expect(status).toContain('> [!WARNING]');
    expect(status).toContain('**Dependency required.**');
    expect(status).toContain('Depends on #123');
    expect(status).not.toContain('All dependencies merged');
    expect(status).not.toContain('| Dependency | Status |');
    expect(octokit.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.pulls.get).toHaveBeenCalledTimes(1);
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('No dependencies found.'));
});

test('replaces stale success with a warning and fails when declarations are removed', async () => {
    body = '';
    comments = [{ id: 10, body: '<!-- pr-dependencies -->\nAll dependencies merged.' }];
    await evaluate();
    const status = octokit.issues.updateComment.mock.calls[0][0].body;
    expect(status).toContain('**Dependency required.**');
    expect(status).not.toContain('All dependencies merged');
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('No dependencies found.'));
});

test('reports comment write failures', async () => {
    octokit.issues.createComment.mockRejectedValue(new Error('Write permission required'));
    await expect(evaluate()).rejects.toThrow('Write permission required');
    expect(core.setFailed).toHaveBeenCalledWith('Write permission required');
});
