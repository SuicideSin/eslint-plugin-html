"use strict"

const path = require("path")
const extract = require("./extract")
const utils = require("./utils")
const splatSet = utils.splatSet
const getSettings = require("./settings").getSettings

const PREPARE_RULE_NAME = "__eslint-plugin-html-prepare"
const LINTER_ISPATCHED_PROPERTY_NAME =
  "__eslint-plugin-html-verify-function-is-patched"

// Disclaimer:
//
// This is not a long term viable solution. ESLint needs to improve its processor API to
// provide access to the configuration before actually preprocess files, but it's not
// planed yet. This solution is quite ugly but shouldn't alter eslint process.
//
// Related github issues:
// https://github.com/eslint/eslint/issues/3422
// https://github.com/eslint/eslint/issues/4153

const needle = path.join("lib", "linter.js")

iterateESLintModules(patch)

function getModuleFromRequire() {
  return require("eslint/lib/linter")
}

function getModuleFromCache(key) {
  if (!key.endsWith(needle)) return

  const module = require.cache[key]
  if (!module || !module.exports) return

  const Linter = module.exports
  if (
    typeof Linter === "function" &&
    typeof Linter.prototype.verify === "function"
  ) {
    return Linter
  }
}

function iterateESLintModules(fn) {
  if (!require.cache || Object.keys(require.cache).length === 0) {
    // Jest is replacing the node "require" function, and "require.cache" isn't available here.
    fn(getModuleFromRequire())
    return
  }

  let found = false

  for (const key in require.cache) {
    const Linter = getModuleFromCache(key)
    if (Linter) {
      fn(Linter)
      found = true
    }
  }

  if (!found) {
    let eslintPath, eslintVersion
    try {
      eslintPath = require.resolve("eslint")
    } catch (e) {
      eslintPath = "(not found)"
    }
    try {
      eslintVersion = require("eslint/package.json").version
    } catch (e) {
      eslintVersion = "n/a"
    }

    const parentPaths = module =>
      module ? [module.filename].concat(parentPaths(module.parent)) : []

    throw new Error(
      `eslint-plugin-html error: It seems that eslint is not loaded.
If you think this is a bug, please file a report at https://github.com/BenoitZugmeyer/eslint-plugin-html/issues

In the report, please include *all* those informations:

* ESLint version: ${eslintVersion}
* ESLint path: ${eslintPath}
* Plugin version: ${require("../package.json").version}
* Plugin inclusion paths: ${parentPaths(module).join(", ")}
* NodeJS version: ${process.version}
* CLI arguments: ${JSON.stringify(process.argv)}
* Content of your lock file (package-lock.json or yarn.lock) or the output of \`npm list\`
* How did you run ESLint (via the command line? an editor plugin?)
* The following stack trace:
    ${new Error().stack.slice(10)}


      `
    )
  }
}

function getMode(pluginSettings, filenameOrOptions) {
  const filename =
    typeof filenameOrOptions === "object"
      ? filenameOrOptions.filename
      : filenameOrOptions
  const extension = path.extname(filename || "")

  if (pluginSettings.htmlExtensions.indexOf(extension) >= 0) {
    return "html"
  }
  if (pluginSettings.xmlExtensions.indexOf(extension) >= 0) {
    return "xml"
  }
}

function patch(Linter) {
  const verify = Linter.prototype.verify

  // ignore if verify function is already been patched sometime before
  if (Linter[LINTER_ISPATCHED_PROPERTY_NAME] === true) {
    return
  }
  Linter[LINTER_ISPATCHED_PROPERTY_NAME] = true
  Linter.prototype.verify = function(
    textOrSourceCode,
    config,
    filenameOrOptions,
    saveState
  ) {
    const pluginSettings = getSettings(config.settings || {})
    const mode = getMode(pluginSettings, filenameOrOptions)

    if (!mode || typeof textOrSourceCode !== "string") {
      return verify.call(
        this,
        textOrSourceCode,
        config,
        filenameOrOptions,
        saveState
      )
    }
    const extractResult = extract(
      textOrSourceCode,
      pluginSettings.indent,
      mode === "xml",
      pluginSettings.isJavaScriptMIMEType
    )

    const messages = []

    if (pluginSettings.reportBadIndent) {
      messages.push(
        ...extractResult.badIndentationLines.map(line => ({
          message: "Bad line indentation.",
          line,
          column: 1,
          ruleId: "(html plugin)",
          severity: pluginSettings.reportBadIndent,
        }))
      )
    }

    // Save code parts parsed source code so we don't have to parse it twice
    const sourceCodes = new WeakMap()
    const verifyCodePart = (codePart, { prepare, ignoreRules } = {}) => {
      this.rules.define(PREPARE_RULE_NAME, context => {
        sourceCodes.set(codePart, context.getSourceCode())
        return {
          Program() {
            if (prepare) {
              prepare(context)
            }
          },
        }
      })

      const localMessages = verify.call(
        this,
        sourceCodes.get(codePart) || String(codePart),
        Object.assign({}, config, {
          rules: Object.assign(
            { [PREPARE_RULE_NAME]: "error" },
            !ignoreRules && config.rules
          ),
        }),
        filenameOrOptions,
        saveState
      )

      messages.push(
        ...remapMessages(localMessages, extractResult.hasBOM, codePart)
      )
    }

    if (config.parserOptions && config.parserOptions.sourceType === "module") {
      for (const codePart of extractResult.code) {
        verifyCodePart(codePart)
      }
    } else {
      verifyWithSharedScopes(extractResult.code, verifyCodePart)
    }

    messages.sort((ma, mb) => ma.line - mb.line || ma.column - mb.column)

    return messages
  }
}

function verifyWithSharedScopes(codeParts, verifyCodePart) {
  // First pass: collect needed globals and declared globals for each script tags.
  const firstPassValues = []

  for (const codePart of codeParts) {
    verifyCodePart(codePart, {
      prepare(context) {
        firstPassValues.push({
          codePart,
          exportedGlobals: context
            .getScope()
            .through.map(node => node.identifier.name),
          declaredGlobals: context
            .getScope()
            .variables.map(variable => variable.name),
        })
      },
      ignoreRules: true,
    })
  }

  // Second pass: declare variables for each script scope, then run eslint.
  for (let i = 0; i < firstPassValues.length; i += 1) {
    verifyCodePart(firstPassValues[i].codePart, {
      prepare(context) {
        const exportedGlobals = splatSet(
          firstPassValues
            .slice(i + 1)
            .map(nextValues => nextValues.exportedGlobals)
        )
        for (const name of exportedGlobals) context.markVariableAsUsed(name)

        const declaredGlobals = splatSet(
          firstPassValues
            .slice(0, i)
            .map(previousValues => previousValues.declaredGlobals)
        )
        const scope = context.getScope()
        scope.through = scope.through.filter(variable => {
          return !declaredGlobals.has(variable.identifier.name)
        })
      },
    })
  }
}

function remapMessages(messages, hasBOM, codePart) {
  const newMessages = []
  const bomOffset = hasBOM ? -1 : 0

  for (const message of messages) {
    const location = codePart.originalLocation({
      line: message.line,
      // eslint-plugin-eslint-comments is raising message with column=0 to bypass ESLint ignore
      // comments. Since messages are already ignored at this time, just reset the column to a valid
      // number. See https://github.com/BenoitZugmeyer/eslint-plugin-html/issues/70
      column: message.column || 1,
    })

    // Ignore messages if they were in transformed code
    if (location) {
      Object.assign(message, location)
      message.source = codePart.getOriginalLine(location.line)

      // Map fix range
      if (message.fix && message.fix.range) {
        message.fix.range = [
          codePart.originalIndex(message.fix.range[0]) + bomOffset,
          // The range end is exclusive, meaning it should replace all characters  with indexes from
          // start to end - 1. We have to get the original index of the last targeted character.
          codePart.originalIndex(message.fix.range[1] - 1) + 1 + bomOffset,
        ]
      }

      // Map end location
      if (message.endLine && message.endColumn) {
        const endLocation = codePart.originalLocation({
          line: message.endLine,
          column: message.endColumn,
        })
        if (endLocation) {
          message.endLine = endLocation.line
          message.endColumn = endLocation.column
        }
      }

      newMessages.push(message)
    }
  }

  return newMessages
}
