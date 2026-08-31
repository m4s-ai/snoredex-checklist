import { readdir, readFile, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { format } from 'prettier';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';

const root = resolve(process.cwd());
const outputPath = join(root, 'docs', 'complexity-report.md');
const shouldWrite = process.argv.includes('--write');
const shouldCheck = process.argv.includes('--check');
const sourceExtensions = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

function scan(source) {
  const scanner = createScanner(true, undefined, source);
  const tokens = [];
  let previous;
  const templateSubstitutionBraces = [];
  let kind;
  do {
    kind = scanner.scan();
    if (kind === SyntaxKind.TemplateHead) templateSubstitutionBraces.push(0);
    if (templateSubstitutionBraces.length > 0) {
      if (kind === SyntaxKind.OpenBraceToken) {
        templateSubstitutionBraces[templateSubstitutionBraces.length - 1] += 1;
      } else if (kind === SyntaxKind.CloseBraceToken) {
        const last = templateSubstitutionBraces.length - 1;
        if (templateSubstitutionBraces[last] > 0) {
          templateSubstitutionBraces[last] -= 1;
        } else {
          const templateKind = scanner.reScanTemplateToken();
          kind = templateKind;
          if (templateKind === SyntaxKind.TemplateTail) templateSubstitutionBraces.pop();
        }
      }
    }
    if (kind === SyntaxKind.SlashToken && shouldRescanSlash(previous)) kind = scanner.reScanSlashToken();
    if (kind !== SyntaxKind.EndOfFile) {
      previous = { kind, text: scanner.getTokenText() };
      tokens.push({ ...previous, start: scanner.getTokenStart() });
    }
  } while (kind !== SyntaxKind.EndOfFile);
  return tokens;
}

function canEndExpression(token) {
  if (!token) return false;
  return [
    SyntaxKind.Identifier,
    SyntaxKind.PrivateIdentifier,
    SyntaxKind.ThisKeyword,
    SyntaxKind.SuperKeyword,
    SyntaxKind.CloseParenToken,
    SyntaxKind.CloseBracketToken,
    SyntaxKind.CloseBraceToken,
    SyntaxKind.PlusPlusToken,
    SyntaxKind.MinusMinusToken,
    SyntaxKind.TrueKeyword,
    SyntaxKind.FalseKeyword,
    SyntaxKind.NullKeyword,
    SyntaxKind.NumericLiteral,
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.RegularExpressionLiteral,
    SyntaxKind.TemplateTail,
  ].includes(token.kind);
}

function shouldRescanSlash(previous) {
  return !canEndExpression(previous);
}

function pairBraces(tokens) {
  const stack = [];
  const pairs = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind === SyntaxKind.OpenBraceToken) stack.push(index);
    if (tokens[index].kind === SyntaxKind.CloseBraceToken) {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, index);
    }
  }
  return pairs;
}

function matching(tokens, start, openKind, closeKind) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].kind === openKind) depth += 1;
    if (tokens[index].kind === closeKind) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function identifierLike(token) {
  return token && (token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.ConstructorKeyword);
}

function looksLikeMethodName(tokens, nameIndex) {
  const previous = tokens[nameIndex - 1];
  if (!previous) return true;
  if ([SyntaxKind.DotToken, SyntaxKind.QuestionDotToken, SyntaxKind.CloseParenToken].includes(previous.kind))
    return false;
  return [
    SyntaxKind.OpenBraceToken,
    SyntaxKind.CloseBraceToken,
    SyntaxKind.SemicolonToken,
    SyntaxKind.CommaToken,
    SyntaxKind.GetKeyword,
    SyntaxKind.SetKeyword,
    SyntaxKind.StaticKeyword,
    SyntaxKind.PublicKeyword,
    SyntaxKind.PrivateKeyword,
    SyntaxKind.ProtectedKeyword,
    SyntaxKind.AsyncKeyword,
    SyntaxKind.AsteriskToken,
  ].includes(previous.kind);
}

function isComputedMethodName(tokens, closeBracketIndex) {
  const openBracket = matchingOpen(
    tokens,
    closeBracketIndex,
    SyntaxKind.OpenBracketToken,
    SyntaxKind.CloseBracketToken,
  );
  return openBracket !== undefined && looksLikeMethodName(tokens, openBracket);
}

function matchingOpen(tokens, close, openKind, closeKind) {
  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    if (tokens[index].kind === closeKind) depth += 1;
    if (tokens[index].kind === openKind) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function hasTypeDeclarationBefore(tokens, from) {
  for (let index = from - 1; index >= 0; index -= 1) {
    const kind = tokens[index].kind;
    if ([SyntaxKind.SemicolonToken, SyntaxKind.CloseBraceToken].includes(kind)) return false;
    if ([SyntaxKind.TypeKeyword, SyntaxKind.InterfaceKeyword, SyntaxKind.DeclareKeyword].includes(kind)) return true;
    if (
      [
        SyntaxKind.ConstKeyword,
        SyntaxKind.LetKeyword,
        SyntaxKind.VarKeyword,
        SyntaxKind.ReturnKeyword,
        SyntaxKind.FunctionKeyword,
        SyntaxKind.EqualsGreaterThanToken,
      ].includes(kind)
    )
      return false;
  }
  return false;
}

function enclosingOpenBrace(tokens, from) {
  let depth = 0;
  for (let index = from - 1; index >= 0; index -= 1) {
    const kind = tokens[index].kind;
    if (kind === SyntaxKind.CloseBraceToken) depth += 1;
    else if (kind === SyntaxKind.OpenBraceToken) {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return undefined;
}

function isTypeDeclarationScope(tokens, from) {
  const open = enclosingOpenBrace(tokens, from);
  return open !== undefined && hasTypeDeclarationBefore(tokens, open);
}

function isTypeMemberScope(tokens, from) {
  const open = enclosingOpenBrace(tokens, from);
  if (open === undefined) return false;
  const before = tokens[open - 1]?.kind;
  if (
    [
      SyntaxKind.CloseParenToken,
      SyntaxKind.CloseBracketToken,
      SyntaxKind.CloseBraceToken,
      SyntaxKind.EqualsGreaterThanToken,
    ].includes(before)
  )
    return false;
  for (let index = open - 1; index >= 0; index -= 1) {
    const kind = tokens[index].kind;
    if ([SyntaxKind.TypeKeyword, SyntaxKind.InterfaceKeyword, SyntaxKind.DeclareKeyword].includes(kind)) return true;
    if (
      [
        SyntaxKind.OpenBraceToken,
        SyntaxKind.CloseBraceToken,
        SyntaxKind.FunctionKeyword,
        SyntaxKind.ConstKeyword,
        SyntaxKind.LetKeyword,
        SyntaxKind.VarKeyword,
        SyntaxKind.ReturnKeyword,
        SyntaxKind.EqualsGreaterThanToken,
      ].includes(kind)
    )
      return false;
  }
  return false;
}

function isTypedFunctionBody(tokens, open) {
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  let angles = 0;
  for (let cursor = open - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.CloseBraceToken) {
      braces += 1;
      continue;
    }
    if (kind === SyntaxKind.OpenBraceToken) {
      if (braces > 0) braces -= 1;
      else return false;
      continue;
    }
    if (kind === SyntaxKind.CloseBracketToken) {
      brackets += 1;
      continue;
    }
    if (kind === SyntaxKind.OpenBracketToken) {
      if (brackets > 0) brackets -= 1;
      else return false;
      continue;
    }
    if (kind === SyntaxKind.CloseParenToken) {
      parens += 1;
      continue;
    }
    if (kind === SyntaxKind.OpenParenToken) {
      if (parens > 0) parens -= 1;
      continue;
    }
    if (kind === SyntaxKind.GreaterThanToken) {
      angles += 1;
      continue;
    }
    if ([SyntaxKind.GreaterThanGreaterThanToken, SyntaxKind.GreaterThanGreaterThanGreaterThanToken].includes(kind)) {
      angles += kind === SyntaxKind.GreaterThanGreaterThanToken ? 2 : 3;
      continue;
    }
    if (kind === SyntaxKind.LessThanToken && angles > 0) {
      angles -= 1;
      continue;
    }
    if (braces > 0 || brackets > 0 || parens > 0 || angles > 0) continue;
    if (kind !== SyntaxKind.ColonToken) continue;
    const parameterClose = cursor - 1;
    if (tokens[parameterClose]?.kind !== SyntaxKind.CloseParenToken) continue;
    const parameterOpen = matchingOpen(tokens, parameterClose, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    if (parameterOpen === undefined) continue;
    for (let parent = parameterOpen - 1; parent >= 0; parent -= 1) {
      const parentKind = tokens[parent].kind;
      if (parentKind === SyntaxKind.FunctionKeyword) return true;
      if ([SyntaxKind.SemicolonToken, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken].includes(parentKind))
        break;
    }
  }
  return false;
}

function isFunctionLikeParameterList(tokens, open) {
  const previous = tokens[open - 1];
  if (!previous) return false;
  if (
    [SyntaxKind.EqualsToken, SyntaxKind.FunctionKeyword, SyntaxKind.AsyncKeyword, SyntaxKind.NewKeyword].includes(
      previous.kind,
    )
  )
    return true;
  if (identifierLike(previous))
    return looksLikeMethodName(tokens, open - 1) || tokens[open - 2]?.kind === SyntaxKind.FunctionKeyword;
  if (
    ![
      SyntaxKind.GreaterThanToken,
      SyntaxKind.GreaterThanGreaterThanToken,
      SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
    ].includes(previous.kind)
  )
    return false;
  let angleDepth = 0;
  for (let index = open - 1; index >= 0; index -= 1) {
    const kind = tokens[index].kind;
    if (kind === SyntaxKind.GreaterThanToken) {
      angleDepth += 1;
      continue;
    }
    if (kind === SyntaxKind.GreaterThanGreaterThanToken) {
      angleDepth += 2;
      continue;
    }
    if (kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      angleDepth += 3;
      continue;
    }
    if (kind === SyntaxKind.LessThanToken) {
      angleDepth -= 1;
      if (angleDepth === 0) {
        const beforeGeneric = tokens[index - 1];
        return (
          [SyntaxKind.EqualsToken, SyntaxKind.FunctionKeyword, SyntaxKind.AsyncKeyword, SyntaxKind.NewKeyword].includes(
            beforeGeneric?.kind,
          ) ||
          (identifierLike(beforeGeneric) &&
            (looksLikeMethodName(tokens, index - 1) || tokens[index - 2]?.kind === SyntaxKind.FunctionKeyword))
        );
      }
    }
  }
  return false;
}

function isParameterTypeLiteral(tokens, open) {
  if (tokens[open - 1]?.kind !== SyntaxKind.ColonToken) return false;
  let parenDepth = 0;
  for (let index = open - 2; index >= 0; index -= 1) {
    const kind = tokens[index].kind;
    if (kind === SyntaxKind.CloseParenToken) {
      parenDepth += 1;
      continue;
    }
    if (kind !== SyntaxKind.OpenParenToken) continue;
    if (parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    const close = matching(tokens, index, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    if (!isFunctionLikeParameterList(tokens, index)) return false;
    return [SyntaxKind.OpenBraceToken, SyntaxKind.EqualsGreaterThanToken, SyntaxKind.ColonToken].includes(
      tokens[close + 1]?.kind,
    );
  }
  return false;
}

function isObjectLiteralOpen(tokens, open) {
  const previousKind = tokens[open - 1]?.kind;
  if (
    [
      SyntaxKind.EqualsToken,
      SyntaxKind.ReturnKeyword,
      SyntaxKind.OpenParenToken,
      SyntaxKind.OpenBracketToken,
      SyntaxKind.CommaToken,
    ].includes(previousKind)
  )
    return true;
  if (previousKind !== SyntaxKind.ColonToken) return false;
  if (isParameterTypeLiteral(tokens, open)) return false;
  const beforeProperty = tokens[open - 3]?.kind;
  if (beforeProperty === SyntaxKind.CommaToken) {
    const close = matching(tokens, open, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken);
    if (
      tokens[close + 1]?.kind === SyntaxKind.CloseParenToken &&
      [SyntaxKind.OpenBraceToken, SyntaxKind.EqualsGreaterThanToken].includes(tokens[close + 2]?.kind)
    )
      return false;
  }
  return [SyntaxKind.OpenBraceToken, SyntaxKind.CommaToken].includes(beforeProperty);
}

function isGenericOpen(tokens, index) {
  const previous = tokens[index - 1]?.kind;
  if (
    [
      SyntaxKind.ColonToken,
      SyntaxKind.AsKeyword,
      SyntaxKind.NewKeyword,
      SyntaxKind.EqualsToken,
      SyntaxKind.OpenParenToken,
      SyntaxKind.OpenBracketToken,
    ].includes(previous)
  )
    return true;
  return identifierLike(tokens[index - 1]) && tokens[index - 2]?.kind === SyntaxKind.AsKeyword;
}

function isCallTypeArgumentOpen(tokens, index) {
  if (!identifierLike(tokens[index - 1])) return false;
  let angles = 0;
  let sawComma = false;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.LessThanToken) {
      angles += 1;
      continue;
    }
    if (kind === SyntaxKind.GreaterThanToken) angles = Math.max(0, angles - 1);
    else if (kind === SyntaxKind.GreaterThanGreaterThanToken) angles = Math.max(0, angles - 2);
    else if (kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) angles = Math.max(0, angles - 3);
    else if (angles > 0 && kind === SyntaxKind.CommaToken) sawComma = true;
    if (angles === 0) return sawComma && tokens[cursor + 1]?.kind === SyntaxKind.OpenParenToken;
  }
  return false;
}

function genericMethodNameIndex(tokens, closeAngleIndex) {
  let angles = 0;
  for (let cursor = closeAngleIndex; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.GreaterThanToken) angles += 1;
    else if (kind === SyntaxKind.GreaterThanGreaterThanToken) angles += 2;
    else if (kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) angles += 3;
    else if (kind === SyntaxKind.LessThanToken) {
      angles -= 1;
      if (angles === 0) {
        const nameIndex = cursor - 1;
        return identifierLike(tokens[nameIndex]) && looksLikeMethodName(tokens, nameIndex) ? nameIndex : undefined;
      }
    }
  }
  return undefined;
}

function isObjectLiteralValueArrow(tokens, from) {
  const open = enclosingOpenBrace(tokens, from);
  if (open === undefined) return false;
  if (!isObjectLiteralOpen(tokens, open)) return false;
  let parens = 0;
  let brackets = 0;
  let angles = 0;
  let sawArrow = false;
  let hasPropertyColon = false;
  for (let index = open + 1; index < from; index += 1) {
    const kind = tokens[index].kind;
    if (kind === SyntaxKind.EqualsGreaterThanToken) sawArrow = true;
    if (kind === SyntaxKind.OpenParenToken) parens += 1;
    else if (kind === SyntaxKind.CloseParenToken) parens = Math.max(0, parens - 1);
    else if (kind === SyntaxKind.OpenBracketToken) brackets += 1;
    else if (kind === SyntaxKind.CloseBracketToken) brackets = Math.max(0, brackets - 1);
    else if (kind === SyntaxKind.LessThanToken && isGenericOpen(tokens, index)) angles += 1;
    else if (kind === SyntaxKind.GreaterThanToken) angles = Math.max(0, angles - 1);
    else if (kind === SyntaxKind.CommaToken && parens === 0 && brackets === 0 && angles === 0) {
      sawArrow = false;
      hasPropertyColon = false;
    } else if (kind === SyntaxKind.ColonToken && parens === 0 && brackets === 0 && angles === 0)
      hasPropertyColon = true;
  }
  return hasPropertyColon && parens === 0 && brackets === 0 && angles === 0 && !sawArrow;
}

function isParenthesizedTypePosition(tokens, open) {
  if (tokens[open - 1]?.kind !== SyntaxKind.OpenParenToken) return false;
  return [
    SyntaxKind.ColonToken,
    SyntaxKind.BarToken,
    SyntaxKind.AmpersandToken,
    SyntaxKind.LessThanToken,
    SyntaxKind.CommaToken,
    SyntaxKind.OpenBracketToken,
  ].includes(tokens[open - 2]?.kind);
}

function isTypeOnlyArrow(tokens, arrowIndex) {
  const close = arrowIndex - 1;
  if (tokens[close]?.kind !== SyntaxKind.CloseParenToken) return false;
  const open = matchingOpen(tokens, close, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
  if (open === undefined) return false;
  if (isTypeDeclarationScope(tokens, open)) return true;
  if (isObjectLiteralValueArrow(tokens, open)) return false;
  if (tokens[open - 1]?.kind === SyntaxKind.NewKeyword) return true;
  if (tokens[open - 1]?.kind === SyntaxKind.LessThanToken) return true;
  if (isParenthesizedTypePosition(tokens, open)) return true;
  if (tokens[open - 1]?.kind === SyntaxKind.ColonToken) return true;
  if (tokens[open - 1]?.kind === SyntaxKind.AsKeyword) return true;
  for (let index = open - 1; index >= 0; index -= 1) {
    const kind = tokens[index].kind;
    if ([SyntaxKind.SemicolonToken, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken].includes(kind)) break;
    if ([SyntaxKind.ConstKeyword, SyntaxKind.LetKeyword, SyntaxKind.VarKeyword].includes(kind)) return false;
    if ([SyntaxKind.TypeKeyword, SyntaxKind.InterfaceKeyword, SyntaxKind.DeclareKeyword].includes(kind)) return true;
  }
  return false;
}

function findBodyOpen(tokens, after, braces) {
  let inReturnType = false;
  let angleDepth = 0;
  for (let index = after + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!inReturnType && token.kind === SyntaxKind.ColonToken) {
      inReturnType = true;
      continue;
    }
    if (inReturnType) {
      if (token.kind === SyntaxKind.LessThanToken) angleDepth += 1;
      if (token.kind === SyntaxKind.GreaterThanToken) angleDepth = Math.max(0, angleDepth - 1);
      if (token.kind === SyntaxKind.GreaterThanGreaterThanToken) angleDepth = Math.max(0, angleDepth - 2);
      if (token.kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) angleDepth = Math.max(0, angleDepth - 3);
      if (token.kind === SyntaxKind.OpenBraceToken) {
        const previousKind = tokens[index - 1]?.kind;
        const typeBrace =
          angleDepth > 0 ||
          [
            SyntaxKind.ColonToken,
            SyntaxKind.LessThanToken,
            SyntaxKind.BarToken,
            SyntaxKind.AmpersandToken,
            SyntaxKind.EqualsGreaterThanToken,
            SyntaxKind.CommaToken,
            SyntaxKind.OpenBracketToken,
            SyntaxKind.OpenParenToken,
          ].includes(previousKind);
        if (typeBrace) {
          const typeClose = braces.get(index);
          if (typeClose === undefined) return undefined;
          index = typeClose;
          continue;
        }
        return index;
      }
      if (token.kind === SyntaxKind.SemicolonToken) return undefined;
      continue;
    }
    if (token.kind === SyntaxKind.OpenBraceToken) return index;
    if ([SyntaxKind.SemicolonToken, SyntaxKind.CommaToken, SyntaxKind.EqualsGreaterThanToken].includes(token.kind))
      return undefined;
  }
  return undefined;
}

function findArrowExpressionEnd(tokens, start) {
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let templateDepth = 0;
  let conditionalDepth = 0;
  let genericDepth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const kind = tokens[index].kind;
    if (kind === SyntaxKind.TemplateHead) {
      templateDepth += 1;
      continue;
    }
    if (kind === SyntaxKind.TemplateMiddle) {
      if (templateDepth === 0) return index;
      continue;
    }
    if (kind === SyntaxKind.TemplateTail) {
      if (templateDepth === 0) return index;
      templateDepth -= 1;
      continue;
    }
    if (kind === SyntaxKind.OpenParenToken) parens += 1;
    else if (kind === SyntaxKind.CloseParenToken) {
      if (parens === 0 && brackets === 0) return index;
      parens -= 1;
    } else if (kind === SyntaxKind.OpenBracketToken) brackets += 1;
    else if (kind === SyntaxKind.CloseBracketToken) {
      if (brackets === 0 && parens === 0) return index;
      brackets -= 1;
    } else if (kind === SyntaxKind.OpenBraceToken) braces += 1;
    else if (kind === SyntaxKind.CloseBraceToken) {
      if (braces === 0 && parens === 0 && brackets === 0) return index;
      braces -= 1;
    } else if (
      kind === SyntaxKind.LessThanToken &&
      (genericDepth > 0 || isGenericOpen(tokens, index) || isCallTypeArgumentOpen(tokens, index))
    ) {
      genericDepth += 1;
    } else if (genericDepth > 0 && kind === SyntaxKind.GreaterThanToken) {
      genericDepth = Math.max(0, genericDepth - 1);
    } else if (genericDepth > 0 && kind === SyntaxKind.GreaterThanGreaterThanToken) {
      genericDepth = Math.max(0, genericDepth - 2);
    } else if (genericDepth > 0 && kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      genericDepth = Math.max(0, genericDepth - 3);
    } else if (
      parens === 0 &&
      brackets === 0 &&
      braces === 0 &&
      genericDepth === 0 &&
      kind === SyntaxKind.QuestionToken
    ) {
      conditionalDepth += 1;
    } else if (parens === 0 && brackets === 0 && braces === 0 && genericDepth === 0 && kind === SyntaxKind.ColonToken) {
      if (conditionalDepth === 0) return index;
      conditionalDepth -= 1;
    } else if (
      parens === 0 &&
      brackets === 0 &&
      braces === 0 &&
      genericDepth === 0 &&
      conditionalDepth === 0 &&
      [SyntaxKind.CommaToken, SyntaxKind.SemicolonToken].includes(kind)
    )
      return index;
  }
  return tokens.length;
}

function findArrowParameterClose(tokens, arrowIndex) {
  if (tokens[arrowIndex - 1]?.kind === SyntaxKind.CloseParenToken) return arrowIndex - 1;
  for (let cursor = arrowIndex - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].kind !== SyntaxKind.CloseParenToken) continue;
    if (matchingOpen(tokens, cursor, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken) === undefined) continue;
    if (tokens[cursor + 1]?.kind === SyntaxKind.ColonToken) return cursor;
  }
  return undefined;
}

function arrowName(tokens, arrowIndex) {
  const parameterClose = findArrowParameterClose(tokens, arrowIndex);
  let cursor = parameterClose === undefined ? arrowIndex - 1 : parameterClose;
  if (parameterClose !== undefined) {
    const parameterOpen = matchingOpen(tokens, parameterClose, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    cursor = parameterOpen === undefined ? parameterClose : parameterOpen - 1;
  }
  if (
    [
      SyntaxKind.GreaterThanToken,
      SyntaxKind.GreaterThanGreaterThanToken,
      SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
    ].includes(tokens[cursor]?.kind)
  ) {
    let angleDepth = 0;
    for (let index = cursor; index >= 0; index -= 1) {
      const kind = tokens[index].kind;
      if (kind === SyntaxKind.GreaterThanToken) angleDepth += 1;
      else if (kind === SyntaxKind.GreaterThanGreaterThanToken) angleDepth += 2;
      else if (kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) angleDepth += 3;
      else if (kind === SyntaxKind.LessThanToken) {
        angleDepth -= 1;
        if (angleDepth === 0) {
          cursor = index - 1;
          break;
        }
      }
    }
  }
  if (tokens[cursor]?.kind === SyntaxKind.EqualsToken && identifierLike(tokens[cursor - 1]))
    return tokens[cursor - 1].text;
  if (tokens[cursor - 1]?.kind === SyntaxKind.EqualsToken && identifierLike(tokens[cursor - 2]))
    return tokens[cursor - 2].text;
  return '<arrow>';
}

function isOptionalTypeProperty(tokens, index) {
  return tokens[index]?.kind === SyntaxKind.QuestionToken && tokens[index + 1]?.kind === SyntaxKind.ColonToken;
}

function isOptionalTypeMethod(tokens, index, start = 0) {
  if (tokens[index]?.kind !== SyntaxKind.QuestionToken || tokens[index + 1]?.kind !== SyntaxKind.OpenParenToken)
    return false;
  return isTypeMemberScope(tokens, index) || isTypeDeclarationScope(tokens, index);
}

function isCatchClause(tokens, index) {
  if ([SyntaxKind.DotToken, SyntaxKind.QuestionDotToken].includes(tokens[index - 1]?.kind)) return false;
  return [SyntaxKind.OpenParenToken, SyntaxKind.OpenBraceToken].includes(tokens[index + 1]?.kind);
}

function isCaseClause(tokens, index) {
  return tokens[index + 1]?.kind !== SyntaxKind.ColonToken && !isKeywordNamedMethod(tokens, index);
}

function isMemberContext(tokens, index) {
  let depth = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.CloseBraceToken) {
      depth += 1;
      continue;
    }
    if (kind !== SyntaxKind.OpenBraceToken) continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    if (isTypedFunctionBody(tokens, cursor)) return false;
    const before = tokens[cursor - 1]?.kind;
    if (
      [
        SyntaxKind.CloseParenToken,
        SyntaxKind.CloseBraceToken,
        SyntaxKind.EqualsGreaterThanToken,
        SyntaxKind.ElseKeyword,
        SyntaxKind.TryKeyword,
        SyntaxKind.FinallyKeyword,
        SyntaxKind.DoKeyword,
      ].includes(before)
    )
      return false;
    if (before === SyntaxKind.Identifier) {
      for (let parent = cursor - 2; parent >= 0; parent -= 1) {
        if (tokens[parent].kind === SyntaxKind.ClassKeyword) return true;
        if (
          [
            SyntaxKind.SemicolonToken,
            SyntaxKind.OpenBraceToken,
            SyntaxKind.CloseBraceToken,
            SyntaxKind.EqualsToken,
            SyntaxKind.ColonToken,
            SyntaxKind.CloseParenToken,
            SyntaxKind.FunctionKeyword,
          ].includes(tokens[parent].kind)
        )
          return false;
      }
      return false;
    }
    return true;
  }
  return false;
}

function isKeywordNamedMethod(tokens, index) {
  if (
    ![
      SyntaxKind.IfKeyword,
      SyntaxKind.ForKeyword,
      SyntaxKind.WhileKeyword,
      SyntaxKind.DoKeyword,
      SyntaxKind.CatchKeyword,
      SyntaxKind.CaseKeyword,
    ].includes(tokens[index]?.kind)
  )
    return false;
  if (!isMemberContext(tokens, index)) return false;
  if (!looksLikeMethodName(tokens, index) || tokens[index + 1]?.kind !== SyntaxKind.OpenParenToken) return false;
  const close = matching(tokens, index + 1, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
  return close !== undefined && tokens[close + 1]?.kind === SyntaxKind.OpenBraceToken;
}

function isConditionalTypeQuestion(tokens, index, start = 0) {
  if (tokens[index]?.kind !== SyntaxKind.QuestionToken) return false;
  let sawExtends = false;
  for (let cursor = index - 1; cursor >= start; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.ExtendsKeyword) {
      sawExtends = true;
      continue;
    }
    if (kind === SyntaxKind.TypeKeyword) return sawExtends;
    if (kind === SyntaxKind.ColonToken && sawExtends) return true;
    if (kind === SyntaxKind.LessThanToken && sawExtends) {
      let angleDepth = 0;
      for (let boundary = cursor; boundary < tokens.length; boundary += 1) {
        const boundaryKind = tokens[boundary].kind;
        if (boundaryKind === SyntaxKind.LessThanToken) angleDepth += 1;
        else if (boundaryKind === SyntaxKind.GreaterThanToken) angleDepth -= 1;
        else if (boundaryKind === SyntaxKind.GreaterThanGreaterThanToken) angleDepth -= 2;
        else if (boundaryKind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) angleDepth -= 3;
        if (angleDepth === 0) {
          if (tokens[boundary + 1]?.kind === SyntaxKind.OpenParenToken) return true;
          break;
        }
      }
    }
    if (kind === SyntaxKind.SemicolonToken) return false;
  }
  return false;
}

function countSourceLines(source) {
  const lines = source.split(/\r\n|\n|\r/u).length;
  return lines - (/(?:\r\n|\n|\r)$/u.test(source) ? 1 : 0);
}

function findStatementEnd(tokens, start) {
  if (start >= tokens.length) return undefined;
  const firstKind = tokens[start].kind;
  if (firstKind === SyntaxKind.OpenBraceToken)
    return matching(tokens, start, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken);
  if (
    [
      SyntaxKind.IfKeyword,
      SyntaxKind.WhileKeyword,
      SyntaxKind.ForKeyword,
      SyntaxKind.WithKeyword,
      SyntaxKind.SwitchKeyword,
    ].includes(firstKind)
  ) {
    const conditionOpen = tokens.findIndex(
      (token, index) => index >= start && token.kind === SyntaxKind.OpenParenToken,
    );
    if (conditionOpen === -1) return undefined;
    const conditionClose = matching(tokens, conditionOpen, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    if (conditionClose === undefined) return undefined;
    const consequentEnd = findStatementEnd(tokens, conditionClose + 1);
    if (consequentEnd === undefined) return undefined;
    if (firstKind === SyntaxKind.IfKeyword && tokens[consequentEnd + 1]?.kind === SyntaxKind.ElseKeyword)
      return findStatementEnd(tokens, consequentEnd + 2);
    return consequentEnd;
  }
  if (firstKind === SyntaxKind.DoKeyword) {
    const bodyEnd = findStatementEnd(tokens, start + 1);
    if (bodyEnd === undefined || tokens[bodyEnd + 1]?.kind !== SyntaxKind.WhileKeyword) return bodyEnd;
    const conditionOpen = bodyEnd + 2;
    if (tokens[conditionOpen]?.kind !== SyntaxKind.OpenParenToken) return bodyEnd;
    const conditionClose = matching(tokens, conditionOpen, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    return conditionClose === undefined
      ? bodyEnd
      : tokens[conditionClose + 1]?.kind === SyntaxKind.SemicolonToken
        ? conditionClose + 1
        : conditionClose;
  }
  if (firstKind === SyntaxKind.TryKeyword) {
    let statementEnd = findStatementEnd(tokens, start + 1);
    if (statementEnd === undefined) return undefined;
    let cursor = statementEnd + 1;
    if (tokens[cursor]?.kind === SyntaxKind.CatchKeyword) {
      if (tokens[cursor + 1]?.kind === SyntaxKind.OpenParenToken) {
        const conditionClose = matching(tokens, cursor + 1, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
        if (conditionClose === undefined) return undefined;
        cursor = conditionClose + 1;
      } else cursor += 1;
      statementEnd = findStatementEnd(tokens, cursor);
      if (statementEnd === undefined) return undefined;
      cursor = statementEnd + 1;
    }
    if (tokens[cursor]?.kind === SyntaxKind.FinallyKeyword) {
      statementEnd = findStatementEnd(tokens, cursor + 1);
      if (statementEnd === undefined) return undefined;
    }
    return statementEnd;
  }
  if (identifierLike(tokens[start]) && tokens[start + 1]?.kind === SyntaxKind.ColonToken)
    return findStatementEnd(tokens, start + 2);
  let parens = 0;
  let brackets = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const kind = tokens[index].kind;
    if (kind === SyntaxKind.OpenParenToken) parens += 1;
    else if (kind === SyntaxKind.CloseParenToken) parens = Math.max(0, parens - 1);
    else if (kind === SyntaxKind.OpenBracketToken) brackets += 1;
    else if (kind === SyntaxKind.CloseBracketToken) brackets = Math.max(0, brackets - 1);
    else if (parens === 0 && brackets === 0 && kind === SyntaxKind.SemicolonToken) return index;
    else if (parens === 0 && brackets === 0 && kind === SyntaxKind.CloseBraceToken) return index - 1;
  }
  return undefined;
}

function isDoWhileContinuation(tokens, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].kind !== SyntaxKind.DoKeyword) continue;
    const bodyEnd = findStatementEnd(tokens, cursor + 1);
    if (bodyEnd === index - 1) return true;
    if (bodyEnd !== undefined && bodyEnd < index - 1) continue;
  }
  return false;
}

function collectFunctions(tokens, source, path) {
  const braces = pairBraces(tokens);
  const functions = [];
  const seen = new Set();
  const add = (start, range, name) => {
    const { bodyOpen, bodyClose, expressionStart, expressionEnd } = range;
    if (bodyOpen !== undefined && bodyClose === undefined) return;
    const end = bodyClose ?? expressionEnd;
    if (end === undefined || seen.has(bodyOpen ?? expressionStart)) return;
    seen.add(bodyOpen ?? expressionStart);
    const line = source.slice(0, tokens[start].start).split(/\r\n|\n|\r/u).length;
    functions.push({
      path: relative(root, path).split('\\').join('/'),
      name,
      line,
      bodyOpen,
      bodyClose,
      expressionStart,
      expressionEnd,
      complexity: 1,
    });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === SyntaxKind.FunctionKeyword) {
      let nameIndex = index + 1;
      if (tokens[nameIndex]?.kind === SyntaxKind.AsteriskToken) nameIndex += 1;
      const named = identifierLike(tokens[nameIndex]);
      const name = named ? tokens[nameIndex].text : '<anonymous>';
      const parameterOpen = tokens.findIndex(
        (candidate, candidateIndex) => candidateIndex >= nameIndex && candidate.kind === SyntaxKind.OpenParenToken,
      );
      const parameterClose =
        parameterOpen === -1
          ? undefined
          : matching(tokens, parameterOpen, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
      const bodyOpen = parameterClose === undefined ? undefined : findBodyOpen(tokens, parameterClose, braces);
      if (bodyOpen !== undefined) add(index, { bodyOpen, bodyClose: braces.get(bodyOpen) }, name);
      continue;
    }
    if (token.kind === SyntaxKind.EqualsGreaterThanToken) {
      if (isTypeOnlyArrow(tokens, index)) continue;
      const name = arrowName(tokens, index);
      if (tokens[index + 1]?.kind === SyntaxKind.OpenBraceToken) {
        const bodyOpen = index + 1;
        add(index - 1, { bodyOpen, bodyClose: braces.get(bodyOpen) }, name);
      } else {
        add(index - 1, { expressionStart: index + 1, expressionEnd: findArrowExpressionEnd(tokens, index + 1) }, name);
      }
      continue;
    }
    if (token.kind !== SyntaxKind.OpenParenToken) continue;
    const nameIndex = index - 1;
    let name;
    if (identifierLike(tokens[nameIndex]) && looksLikeMethodName(tokens, nameIndex)) name = tokens[nameIndex].text;
    else if (isKeywordNamedMethod(tokens, nameIndex)) name = tokens[nameIndex].text;
    else if (tokens[nameIndex]?.kind === SyntaxKind.CloseBracketToken && isComputedMethodName(tokens, nameIndex))
      name = '<computed>';
    else if (
      [
        SyntaxKind.GreaterThanToken,
        SyntaxKind.GreaterThanGreaterThanToken,
        SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ].includes(tokens[nameIndex]?.kind)
    ) {
      const genericName = genericMethodNameIndex(tokens, nameIndex);
      if (genericName === undefined) continue;
      name = tokens[genericName].text;
    } else continue;
    const close = matching(tokens, index, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    const bodyOpen = close === undefined ? undefined : findBodyOpen(tokens, close, braces);
    if (bodyOpen !== undefined) add(nameIndex, { bodyOpen, bodyClose: braces.get(bodyOpen) }, name);
  }

  for (const entry of functions) {
    const start = entry.bodyOpen === undefined ? entry.expressionStart : entry.bodyOpen + 1;
    const end = entry.bodyClose ?? entry.expressionEnd;
    for (let index = start; index < end; index += 1) {
      const nested = functions.find(
        (candidate) =>
          (candidate.bodyOpen === index || candidate.expressionStart === index) &&
          (candidate.bodyClose ?? candidate.expressionEnd) < end,
      );
      if (nested) {
        index = nested.bodyClose ?? nested.expressionEnd;
        continue;
      }
      if (
        [
          SyntaxKind.IfKeyword,
          SyntaxKind.ForKeyword,
          SyntaxKind.WhileKeyword,
          SyntaxKind.DoKeyword,
          SyntaxKind.CatchKeyword,
          SyntaxKind.CaseKeyword,
          SyntaxKind.QuestionToken,
          SyntaxKind.AmpersandAmpersandToken,
          SyntaxKind.BarBarToken,
          SyntaxKind.QuestionQuestionToken,
        ].includes(tokens[index].kind)
      ) {
        if (
          !isOptionalTypeProperty(tokens, index) &&
          !isOptionalTypeMethod(tokens, index, start) &&
          !isKeywordNamedMethod(tokens, index) &&
          !isConditionalTypeQuestion(tokens, index, start) &&
          (tokens[index].kind !== SyntaxKind.CatchKeyword || isCatchClause(tokens, index)) &&
          (tokens[index].kind !== SyntaxKind.CaseKeyword || isCaseClause(tokens, index)) &&
          (tokens[index].kind !== SyntaxKind.WhileKeyword || !isDoWhileContinuation(tokens, index))
        )
          entry.complexity += 1;
      }
    }
    delete entry.bodyOpen;
    delete entry.bodyClose;
    delete entry.expressionStart;
    delete entry.expressionEnd;
  }
  return functions;
}

async function sourceFiles(directory) {
  const files = [];
  async function visit(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && sourceExtensions.includes(extname(entry.name))) files.push(path);
    }
  }
  await visit(directory);
  return files;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function reportFor(files) {
  const entries = [];
  let lines = 0;
  for (const path of files) {
    const source = files.sourceByPath.get(path);
    lines += countSourceLines(source);
    entries.push(...collectFunctions(scan(source), source, path));
  }
  entries.sort(
    (left, right) =>
      right.complexity - left.complexity ||
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.name.localeCompare(right.name),
  );
  const values = entries.map((entry) => entry.complexity).sort((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);
  const mean = values.length === 0 ? 0 : sum / values.length;
  return [
    '# Cyclomatic complexity baseline',
    '',
    '> Advisory lexical estimate; this is not a release gate or a conformance claim.',
    '',
    `Scope: \`src/\` and \`scripts/\` (${files.length} production code files).`,
    `Lines: ${lines.toLocaleString('en-US')}.`,
    `Function-like nodes: ${entries.length.toLocaleString('en-US')}.`,
    `McCabe estimate: sum ${sum.toLocaleString('en-US')}; mean ${mean.toFixed(1)}; median ${percentile(values, 0.5)}; P90 ${percentile(values, 0.9)}; P95 ${percentile(values, 0.95)}.`,
    `Hotspots: ${entries.filter((entry) => entry.complexity > 10).length} functions exceed 10; ${entries.filter((entry) => entry.complexity > 20).length} exceed 20.`,
    '',
    'The estimate counts if/for/while/do/catch/case statements, conditional `?` tokens and `&&`/`||`/`??` operators inside function-like bodies. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.',
    '',
    '| Location | Function | Complexity |',
    '| --- | --- | ---: |',
    ...entries
      .slice(0, 20)
      .map((entry) => `| \`${entry.path}:${entry.line}\` | \`${entry.name}\` | ${entry.complexity} |`),
    '',
  ].join('\n');
}

if (process.argv.includes('--self-test')) {
  const samples = [
    {
      source:
        'function typed({ enabled }: { enabled: boolean }): { ok: boolean } { if (enabled) return { ok: true }; return { ok: false }; }',
      expected: [{ name: 'typed', complexity: 2 }],
    },
    {
      source: 'const expression = (value) => value && value > 0 ? value : 0;',
      expected: [{ name: 'expression', complexity: 3 }],
    },
    {
      source: `function anonymousHost(value) {
        return function (input) { if (input) return input; return value; };
      }
      function generatorHost(value) {
        return function* (input) { if (input) yield input; return value; };
      }`,
      expected: [
        { name: 'anonymousHost', complexity: 1 },
        { name: '<anonymous>', complexity: 2 },
        { name: 'generatorHost', complexity: 1 },
        { name: '<anonymous>', complexity: 2 },
      ],
    },
    {
      source: 'const conciseObject = (value, ready) => value ? { first: 1, second: ready && value } : null;',
      expected: [{ name: 'conciseObject', complexity: 3 }],
    },
    {
      source: 'function outer(values) { return values.map((value) => value ? value : 0); }',
      expected: [
        { name: 'outer', complexity: 1 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: 'function slash(value) { const pattern = /a&&b/u; return value / 2 && value; }',
      expected: [{ name: 'slash', complexity: 2 }],
    },
    {
      source: `class Visibility {
        public visible(value) { if (value) return true; return false; }
        private hidden(value) { if (value) return true; return false; }
      }`,
      expected: [
        { name: 'visible', complexity: 2 },
        { name: 'hidden', complexity: 2 },
      ],
    },
    {
      source: `type Handler = (value: string) => boolean;
        interface Handlers { callback?: (value: string) => boolean; }
        const typed: (value: string) => boolean = (value) => value.length > 0;`,
      expected: [{ name: '<arrow>', complexity: 1 }],
    },
    {
      source: `const invoke = (request) => (request as (name: string) => Promise<string>)(name);`,
      expected: [{ name: 'invoke', complexity: 1 }],
    },
    {
      source: 'type Constructor = new (value: string) => Promise<string>; const build = (value) => value ? value : "";',
      expected: [{ name: 'build', complexity: 2 }],
    },
    {
      source: 'function template(value) { return `raw ${value ? 1 : 2} literal?` ?? value; }',
      expected: [{ name: 'template', complexity: 3 }],
    },
    {
      source: 'function optionalType(value) { const result: { enabled?: boolean } = {}; return value ? result : {}; }',
      expected: [{ name: 'optionalType', complexity: 2 }],
    },
    {
      source: 'function nestedTemplate(localization) { return `${{ localization }.localization ?? "unknown"}`; }',
      expected: [{ name: 'nestedTemplate', complexity: 2 }],
    },
    {
      source: 'function host(x, y, z) { return `${x => x && y}` && (z ? 1 : 2); }',
      expected: [
        { name: 'host', complexity: 3 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: 'const templateArrow = (x, y, z) => `${x ? y : z}-${y && z}`;',
      expected: [{ name: 'templateArrow', complexity: 3 }],
    },
    {
      source:
        'function conditionalArrow(cond, fallback, other) { return cond ? (x) => x && fallback : fallback || other; }',
      expected: [
        { name: 'conditionalArrow', complexity: 3 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: 'const load = () => choose<A, B>(ready && value);',
      expected: [{ name: 'load', complexity: 2 }],
    },
    {
      source: 'const typedArrow = (value): QueryParse => value ? value : undefined;',
      expected: [{ name: 'typedArrow', complexity: 2 }],
    },
    {
      source: 'const nestedGeneric = () => choose<Result<A, B>>(ready && value);',
      expected: [{ name: 'nestedGeneric', complexity: 2 }],
    },
    {
      source: `class GenericMethod {
        map<T>(value: T) { if (value) return value; return undefined; }
      }`,
      expected: [{ name: 'map', complexity: 2 }],
    },
    {
      source: 'function keywordProperty(value, ready) { return { catch: value && ready }; }',
      expected: [{ name: 'keywordProperty', complexity: 2 }],
    },
    {
      source: 'function caseProperty(value, ready) { return { case: value && ready }; }',
      expected: [{ name: 'caseProperty', complexity: 2 }],
    },
    {
      source: `function caseMethodHost(ready) {
        return { case() { if (ready) return 1; return 0; } };
      }`,
      expected: [
        { name: 'caseMethodHost', complexity: 1 },
        { name: 'case', complexity: 2 },
      ],
    },
    {
      source: `function switchCase(value) {
        switch (value) {
          case 1:
            return true;
          default:
            return false;
        }
      }`,
      expected: [{ name: 'switchCase', complexity: 2 }],
    },
    {
      source: `function conditionalType(value) {
        type Choice<T> = T extends true ? string : number;
        if (value) return value;
        return undefined;
      }`,
      expected: [{ name: 'conditionalType', complexity: 2 }],
    },
    {
      source: `function conditionalObjectType(value) {
        type Choice<T> = T extends { value: unknown } ? string : number;
        if (value) return value;
        return undefined;
      }`,
      expected: [{ name: 'conditionalObjectType', complexity: 2 }],
    },
    {
      source: `function conditionalAnnotation(value) {
        const result: T extends string ? string : number = value as never;
        if (value) return result;
        return undefined;
      }`,
      expected: [{ name: 'conditionalAnnotation', complexity: 2 }],
    },
    {
      source: `function keywordMethods(ready) {
        return { catch() { if (ready) return 1; }, if() { while (ready) return 2; } };
      }`,
      expected: [
        { name: 'keywordMethods', complexity: 1 },
        { name: 'catch', complexity: 2 },
        { name: 'if', complexity: 2 },
      ],
    },
    {
      source: `function postStatementControls(value) {
        value += 1;
        if (value) return value;
        return 0;
      }
      function postBlockControl(value) {
        if (value) { return value; }
        { for (const item of [value]) value += item; }
        return value;
      }`,
      expected: [
        { name: 'postStatementControls', complexity: 2 },
        { name: 'postBlockControl', complexity: 3 },
      ],
    },
    {
      source: `function conditionalParameter(value: T extends string ? A : B) {
        return value ? value : undefined;
      }`,
      expected: [{ name: 'conditionalParameter', complexity: 2 }],
    },
    {
      source: `function optionalTypeMethod(value) {
        type Hooks = { ready?(): boolean };
        if (value) return value;
        return undefined;
      }`,
      expected: [{ name: 'optionalTypeMethod', complexity: 2 }],
    },
    {
      source: `function genericConditional(value) {
        return factory<T extends string ? A : B>() || value;
      }`,
      expected: [{ name: 'genericConditional', complexity: 2 }],
    },
    {
      source: `function typedReturn(value: T): Result {
        for (const item of value) if (item) return item;
        return value;
      }`,
      expected: [{ name: 'typedReturn', complexity: 3 }],
    },
    {
      source: `function typedGenericReturn(value: T): Promise<Result> {
        for (const item of value) if (item) return item;
        return value;
      }`,
      expected: [{ name: 'typedGenericReturn', complexity: 3 }],
    },
    {
      source: `function optionalTypeScopes(value) {
        interface Hooks { ready?(): boolean }
        type MoreHooks = { first(): boolean; ready?(): boolean };
        if (value) return value;
        return undefined;
      }`,
      expected: [{ name: 'optionalTypeScopes', complexity: 2 }],
    },
    {
      source: `function relationalExtends(value, limit, flags) {
        return value < limit && flags.extends ? value : limit;
      }`,
      expected: [{ name: 'relationalExtends', complexity: 3 }],
    },
    {
      source: 'function wrapped(): Promise<{ ok: boolean }> { if (true) return { ok: true }; return { ok: false }; }',
      expected: [{ name: 'wrapped', complexity: 2 }],
    },
    {
      source: 'function union(): { ok: boolean } | null { return null; }',
      expected: [{ name: 'union', complexity: 1 }],
    },
    {
      source: `function storage() {
        return {
          register: (onInactive, onActive) => {
            if (onInactive) return onActive;
            return onInactive;
          },
        };
      }`,
      expected: [
        { name: 'storage', complexity: 1 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: `function expressionStorage() {
        return { register: (value) => (value ? value : undefined) };
      }`,
      expected: [
        { name: 'expressionStorage', complexity: 1 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: `interface GenericStorage {
        readonly listKeys?: (prefix: string) => readonly string[];
        readonly withAtomicUpdate?: <T>(callback: () => T) => T;
      }`,
      expected: [],
    },
    {
      source: `function wrappedTypes() {
        let retryAction: (() => Promise<unknown>) | undefined;
        const callbacks = new Set<() => void>();
        return retryAction ?? callbacks;
      }`,
      expected: [{ name: 'wrappedTypes', complexity: 2 }],
    },
    {
      source: `function nestedTypes() {
        return {
          request: <T>(name: string, callback: () => Promise<T>): Promise<T> =>
            (request as (lockName: string, lockCallback: () => Promise<T>) => Promise<T>).call(name, callback),
        };
      }`,
      expected: [
        { name: 'nestedTypes', complexity: 1 },
        { name: '<arrow>', complexity: 1 },
      ],
    },
    {
      source: 'function rejection(value) { return value.catch(() => undefined); }',
      expected: [
        { name: 'rejection', complexity: 1 },
        { name: '<arrow>', complexity: 1 },
      ],
    },
    {
      source: `function multipleProperties(value) {
        return {
          first: (entry) => (entry < value ? entry : value),
          second: (entry) => entry && entry.ok,
        };
      }`,
      expected: [
        { name: 'multipleProperties', complexity: 1 },
        { name: '<arrow>', complexity: 2 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: `class ParameterTypes {
        constructor(first: unknown, options: { readonly now?: () => string }, last: unknown) {}
      }`,
      expected: [{ name: 'constructor', complexity: 1 }],
    },
    {
      source: `class ComputedMethod {
        [Symbol.iterator]() { if (ready) return value; return undefined; }
      }`,
      expected: [{ name: '<computed>', complexity: 2 }],
    },
    {
      source: `function doWhile(value) {
        do {
          value -= 1;
        } while (value > 0);
        return value;
      }`,
      expected: [{ name: 'doWhile', complexity: 2 }],
    },
    {
      source: `function doWhileUnbraced(value) {
        do value -= 1; while (value > 0);
        return value;
      }`,
      expected: [{ name: 'doWhileUnbraced', complexity: 2 }],
    },
    {
      source: `function doWhileCompound(value) {
        do while (value > 0) step(); while (value < 10);
        return value;
      }`,
      expected: [{ name: 'doWhileCompound', complexity: 3 }],
    },
    {
      source: `function doWhileIf(value) {
        do if (value > 0) step(); else step(); while (value < 10);
        return value;
      }`,
      expected: [{ name: 'doWhileIf', complexity: 3 }],
    },
    {
      source: `function controlExpression(value, ready) {
        if ({ nested: { callback: (x) => x && ready } }.nested.callback(value)) return value;
        return value;
      }`,
      expected: [
        { name: 'controlExpression', complexity: 2 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: `function namedParameterTypes(first, options: { cb?: () => void }, last) {}
        function tryBody(value, ready) {
          do try { step(value); } finally { stop(value); } while (ready);
          return value;
        }`,
      expected: [
        { name: 'namedParameterTypes', complexity: 1 },
        { name: 'tryBody', complexity: 2 },
      ],
    },
    {
      source: `function labeledBody(value, ready) {
        do body: { step(value); } while (ready);
        return value;
      }`,
      expected: [{ name: 'labeledBody', complexity: 2 }],
    },
    {
      source: `function comparison(value, minimum, ready) {
        if (value > (minimum)) { if (ready) act(); }
      }`,
      expected: [{ name: 'comparison', complexity: 3 }],
    },
    {
      source: `class NestedGenericMethod {
        map<T extends Foo<Bar>>(value: T) { if (value) return value; return undefined; }
      }`,
      expected: [{ name: 'map', complexity: 2 }],
    },
    {
      source: `class GenericParameterTypes {
        map<T extends Foo<Bar>>(first: T, options: { cb?: () => void }, last: T) {
          if (first) return last;
          return first;
        }
      }`,
      expected: [{ name: 'map', complexity: 2 }],
    },
    {
      source: 'const genericArrow = <T extends Element>(selector: string): T => selector ? selector : undefined;',
      expected: [{ name: 'genericArrow', complexity: 2 }],
    },
    {
      source: `function genericFunctionWithObject<T extends Foo<Bar>>(first: T, options: { cb?: () => void }, last: T) {
        return last;
      }`,
      expected: [{ name: 'genericFunctionWithObject', complexity: 1 }],
    },
    {
      source:
        'const genericArrowWithObject = <T extends Foo<Bar>>(first: T, options: { cb?: () => void }, last: T) => last;',
      expected: [{ name: 'genericArrowWithObject', complexity: 1 }],
    },
  ];
  for (const sample of samples) {
    const actual = collectFunctions(scan(sample.source), sample.source, 'fixture.ts').map(({ name, complexity }) => ({
      name,
      complexity,
    }));
    assert.deepEqual(actual, sample.expected);
  }
  assert.equal(countSourceLines('one\n'), 1);
  assert.equal(countSourceLines('one\n\ntwo\n'), 3);
  console.log('complexity self-test passed');
  process.exit(0);
}

const files = await sourceFiles(join(root, 'src'));
files.push(...(await sourceFiles(join(root, 'scripts'))));
files.sourceByPath = new Map();
for (const path of files) files.sourceByPath.set(path, await readFile(path, 'utf8'));
const report = await format(reportFor(files), { endOfLine: 'lf', parser: 'markdown' });

if (shouldWrite) {
  await writeFile(outputPath, report, 'utf8');
  console.log(`wrote ${relative(root, outputPath)}`);
} else if (shouldCheck) {
  const current = await readFile(outputPath, 'utf8').catch(() => undefined);
  if (current !== report) {
    console.error('complexity report is stale; run npm run complexity:report');
    process.exitCode = 1;
  } else {
    console.log('complexity report is current');
  }
} else {
  process.stdout.write(report);
}
