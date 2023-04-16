/** Based on Stylish reporter from Sindre Sorhus */
'use strict';

var chalk = require('chalk'),
  stripAnsi = require('strip-ansi'),
  table = require('text-table'),
  extend = require('extend');

var path = require('path');

var fs = require('fs');
const { sortBy } = require('lodash');
var codeFrameColumns = require('@babel/code-frame').codeFrameColumns;

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

/**
 * Given a word and a count, append an s if count is not one.
 *
 * @param {string} word A word in its singular form.
 * @param {number} count A number controlling whether word should be pluralized.
 * @returns {string} The original word with an s on the end if count is not one.
 */
function pluralize(word, count) {
  return count === 1 ? word : word + 's';
}

var parseBoolEnvVar = function (varName) {
  var env = process.env || {};
  return env[varName] === 'true';
};

var parseEnvVal = function (varName) {
  var env = process.env || {};
  return env[varName];
};

var subtleLog = function (args) {
  return parseBoolEnvVar('EFF_NO_GRAY') ? args : chalk.gray(args);
};

var getEnvVar = function (varName) {
  var env = process.env || {};
  return env[varName] || false;
};

var getFileLink = function (_path, line, column) {
  var scheme = getEnvVar('EFF_EDITOR_SCHEME');
  if (scheme === false) {
    return false;
  }
  return scheme
    .replace('{file}', encodeURIComponent(_path))
    .replace('{line}', line)
    .replace('{column}', column);
};

var getKeyLink = function (key, resultsMeta) {
  const metaUrl = resultsMeta?.rulesMeta?.[key]?.docs?.url;
  let searchEngineLink =
    getEnvVar('EFF_RULE_SEARCH_LINK') || 'https://google.com/search?q=';
  var url = metaUrl || `${searchEngineLink}${key}`;
  return chalk.underline(subtleLog(url));
};

var printSummary = function (hash, title, method, resultsMeta) {
  var res = '\n\n' + chalk[method](title + ':') + chalk.white('\n');
  res += table(
    Object.keys(hash)
      .sort(function (a, b) {
        return hash[a] > hash[b] ? -1 : 1;
      })
      .map(function (key) {
        return [
          ['', hash[key], chalk.white(key)],
          ['', '', `  ${getKeyLink(key, resultsMeta)}`],
        ];
      })
      .flat(),
    {
      align: [undefined, 'r', 'l'],
      stringLength: function (str) {
        return stripAnsi(str).length;
      },
    },
  );
  return res;
};

var tryParseJSONObject = function (jsonString) {
  try {
    var o = JSON.parse(jsonString);
    if (o && typeof o === 'object') {
      return o;
    }
  } catch (e) {}

  return false;
};

//------------------------------------------------------------------------------
// Public Interface
//------------------------------------------------------------------------------

/**
 * @param {import('eslint').ESLint.LintResult[]} results The lint results to format.
 * @param {import('eslint').ESLint.LintResultData} resultsMeta Warning count and max
 *   threshold.
 * @returns {string | Promise<string>} The formatted lint results.
 */
function format(results, resultsMeta) {
  var output = '\n',
    total = 0,
    errors = 0,
    warnings = 0,
    summaryColor = 'yellow';

  results = results || [];

  var entries = [];

  var absolutePathsToFile = parseBoolEnvVar('EFF_ABSOLUTE_PATHS');

  var groupByIssue = parseBoolEnvVar('EFF_BY_ISSUE');
  var filterRule = parseEnvVal('EFF_FILTER');
  var showSource = !parseBoolEnvVar('EFF_NO_SOURCE');

  var errorsHash = {};
  var warningsHash = {};

  results.forEach(function (result) {
    if (!result.messages || result.messages.length === 0) {
      return;
    }

    const fileSource = result.source || fs.readFileSync(result.filePath, 'utf8');
    entries = entries.concat(
      result.messages.map(function (message) {
        return extend(
          {
            filePath: absolutePathsToFile
              ? path.resolve(result.filePath)
              : path.relative('.', result.filePath),
          },
          message,
          {
            fileSource,
          },
        );
      }),
    );
  });

  entries = sortBy(
    entries,
    ['severity', groupByIssue && 'ruleId', 'filePath', 'line', 'column'].filter(
      Boolean,
    ),
  );

  var lastRuleId;

  output +=
    entries
      .reduce(function (seq, message) {
        var messageType;

        if (filterRule) {
          if (message.ruleId !== filterRule) {
            return seq;
          }
        }

        if (message.fatal || message.severity === 2) {
          messageType = chalk.red('✘');
          summaryColor = 'red';
          errorsHash[message.ruleId] = (errorsHash[message.ruleId] || 0) + 1;
          errors++;
        } else {
          messageType = chalk.yellow('⚠');
          warningsHash[message.ruleId] = (warningsHash[message.ruleId] || 0) + 1;
          warnings++;
        }

        var line = message.line || 0;
        var column = message.column || 0;

        var filePath = message.filePath;
        var link = getFileLink(filePath, line, column);
        var filename = subtleLog(filePath + ':' + line + ':' + column);

        function renderTitle() {
          return `\n  ${messageType}  ${chalk.white(message.ruleId)}${!parseBoolEnvVar('EFF_NO_LINK_RULES') ? ` - ${getKeyLink(message.ruleId || '', resultsMeta)}` : ''}`;
        }

        function renderLink() {
          return link === false ? '' : '     ' + chalk.underline(subtleLog(link));
        }

        function renderDescription() {
          return '\n     ' + message.message.replace(/\.$/, '') + '\n';
        }

        function renderFileLink() {
          return (
            (showSource ? '\n' : '') +
            '     ' +
            (link === false ? chalk.underline(filename) : filename)
          );
        }

        function renderSourceCode() {
          const location = {
            start: {
              line: message.line,
              column: message.column,
            },
          };
          const codeFrameOptions = tryParseJSONObject(
            getEnvVar('EFF_CODE_FRAME_OPTIONS'),
          ) || { highlightCode: true };

          return showSource
            ? codeFrameColumns(message.fileSource, location, codeFrameOptions)
                .split('\n')
                .map((l) => '   ' + l)
                .join('\n')
            : '';
        }

        function createLine(arr) {
          return arr
            .filter(function (l) {
              return !!(l || '').trim();
            })
            .join('\n');
        }

        if (groupByIssue) {
          var isSameIssueAsLastOne = lastRuleId === message.ruleId;
          lastRuleId = message.ruleId;

          seq.push(
            createLine([
              !isSameIssueAsLastOne ? renderTitle() : '',
              !isSameIssueAsLastOne ? renderLink() : '',
              renderFileLink(),
              renderSourceCode(),
            ]),
          );
        } else {
          seq.push(
            createLine([
              renderTitle(),
              renderLink(),
              renderDescription(),
              renderFileLink(),
              renderSourceCode(),
            ]),
          );
        }

        return seq;
      }, [])
      .join('\n') + '\n\n';

  total = entries.length;

  if (total > 0) {
    output +=
      chalk[summaryColor].bold(
        [
          '✘ ',
          total,
          pluralize(' problem', total),
          ' (',
          errors,
          pluralize(' error', errors),
          ', ',
          warnings,
          pluralize(' warning', warnings),
          ')',
        ].join(''),
      ) + chalk.white('\n');

    if (errors > 0) {
      output += printSummary(errorsHash, 'Errors', 'red', resultsMeta) + '\n';
    }

    if (warnings > 0) {
      output += printSummary(warningsHash, 'Warnings', 'yellow', resultsMeta) + '\n';
    }
  }

  if (
    process.env.FORCE_ITERM_HINT === 'true' ||
    (process.stdout.isTTY && !process.env.CI)
  ) {
    output = '\u001B]1337;CurrentDir=' + process.cwd() + '\u0007' + output;
  }

  return total > 0 ? output : '';
}

module.exports = format;
