import { readdir, readFile, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { format } from 'prettier';
import { createScanner, isBinaryOperator, SyntaxKind } from 'typescript/unstable/ast';

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
    if (kind === SyntaxKind.SlashToken && shouldRescanSlash(previous, tokens, scanner, source))
      kind = scanner.reScanSlashToken();
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
    SyntaxKind.BigIntLiteral,
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.RegularExpressionLiteral,
    SyntaxKind.TemplateTail,
  ].includes(token.kind);
}

function isControlHeaderClose(tokens, closeIndex) {
  if (tokens[closeIndex]?.kind !== SyntaxKind.CloseParenToken) return false;
  const openIndex = matchingOpen(tokens, closeIndex, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
  if (openIndex === undefined) return false;
  if ([SyntaxKind.DotToken, SyntaxKind.QuestionDotToken].includes(tokens[openIndex - 2]?.kind)) return false;
  return [
    SyntaxKind.IfKeyword,
    SyntaxKind.WhileKeyword,
    SyntaxKind.ForKeyword,
    SyntaxKind.WithKeyword,
    SyntaxKind.SwitchKeyword,
    SyntaxKind.CatchKeyword,
  ].includes(tokens[openIndex - 1]?.kind);
}

function shouldRescanSlash(previous, tokens = [], scanner) {
  const memberProperty = isMemberPropertyAccess(tokens, tokens.length - 1);
  const postfixNonNull = isPostfixNonNullAssertion(tokens, tokens.length - 1);
  const typeAssertion = isTypeAssertionKeyword(tokens, tokens.length - 1);
  const regexAfterTypeAssertion =
    typeAssertion &&
    scanner.lookAhead(() => {
      const kind = scanner.reScanSlashToken();
      if (kind !== SyntaxKind.RegularExpressionLiteral || scanner.isUnterminated()) return false;
      const next = scanner.scan();
      return [
        SyntaxKind.EndOfFile,
        SyntaxKind.DotToken,
        SyntaxKind.QuestionDotToken,
        SyntaxKind.OpenParenToken,
        SyntaxKind.OpenBracketToken,
        SyntaxKind.AmpersandAmpersandToken,
        SyntaxKind.BarBarToken,
        SyntaxKind.QuestionToken,
        SyntaxKind.ColonToken,
        SyntaxKind.CommaToken,
        SyntaxKind.SemicolonToken,
        SyntaxKind.CloseParenToken,
        SyntaxKind.CloseBracketToken,
        SyntaxKind.CloseBraceToken,
      ].includes(next);
    });
  return (
    (!canEndExpression(previous) && !memberProperty && !postfixNonNull && !typeAssertion) ||
    regexAfterTypeAssertion ||
    isControlHeaderClose(tokens, tokens.length - 1)
  );
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

function matchingAngleClose(tokens, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const kind = tokens[index].kind;
    if (kind === SyntaxKind.LessThanToken) depth += 1;
    else if (kind === SyntaxKind.GreaterThanToken) depth -= 1;
    else if (kind === SyntaxKind.GreaterThanGreaterThanToken) depth -= 2;
    else if (kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) depth -= 3;
    if (depth === 0) return index;
  }
  return undefined;
}

function enclosingAngleOpen(tokens, index, start = 0) {
  for (let cursor = index - 1; cursor >= start; cursor -= 1) {
    if (tokens[cursor].kind !== SyntaxKind.LessThanToken) continue;
    const close = matchingAngleClose(tokens, cursor);
    if (close !== undefined && index < close) return cursor;
  }
  return undefined;
}

function isFunctionTypeParameterArrow(tokens, arrowIndex) {
  const close = arrowIndex - 1;
  if (tokens[close]?.kind !== SyntaxKind.CloseParenToken) return false;
  for (let cursor = close; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if ([SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken, SyntaxKind.SemicolonToken].includes(kind)) return false;
    if (kind !== SyntaxKind.FunctionKeyword) continue;
    let nameIndex = cursor + 1;
    if (tokens[nameIndex]?.kind === SyntaxKind.AsteriskToken) nameIndex += 1;
    const genericStart = identifierLike(tokens[nameIndex]) ? nameIndex + 1 : nameIndex;
    if (tokens[genericStart]?.kind !== SyntaxKind.LessThanToken) return false;
    const genericClose = matchingAngleClose(tokens, genericStart);
    return genericClose !== undefined && arrowIndex < genericClose;
  }
  return false;
}

function isMethodTypeParameterArrow(tokens, arrowIndex) {
  const close = arrowIndex - 1;
  if (tokens[close]?.kind !== SyntaxKind.CloseParenToken) return false;
  for (let cursor = close; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].kind !== SyntaxKind.LessThanToken) continue;
    const genericClose = matchingAngleClose(tokens, cursor);
    if (genericClose === undefined || arrowIndex >= genericClose) continue;
    const nameIndex = cursor - 1;
    if (tokens[genericClose + 1]?.kind === SyntaxKind.OpenParenToken) {
      const parameterClose = matching(tokens, genericClose + 1, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
      if (parameterClose !== undefined && tokens[parameterClose + 1]?.kind === SyntaxKind.EqualsGreaterThanToken)
        return true;
      let expressionStart = nameIndex;
      while (tokens[expressionStart]?.kind === SyntaxKind.OpenParenToken) expressionStart -= 1;
      if (tokens[expressionStart]?.kind === SyntaxKind.EqualsToken) return true;
    }
    if (
      (methodNameLike(tokens[nameIndex]) && looksLikeMethodName(tokens, nameIndex)) ||
      (tokens[nameIndex]?.kind === SyntaxKind.CloseBracketToken && isComputedMethodName(tokens, nameIndex))
    )
      return isMemberContext(tokens, nameIndex);
  }
  return false;
}

function isClassTypeParameterArrow(tokens, arrowIndex) {
  const close = arrowIndex - 1;
  if (tokens[close]?.kind !== SyntaxKind.CloseParenToken) return false;
  for (let cursor = close; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].kind !== SyntaxKind.LessThanToken) continue;
    const genericClose = matchingAngleClose(tokens, cursor);
    if (genericClose === undefined || arrowIndex >= genericClose) continue;
    const nameIndex = cursor - 1;
    if (
      tokens[nameIndex]?.kind === SyntaxKind.ClassKeyword ||
      (identifierLike(tokens[nameIndex]) && tokens[nameIndex - 1]?.kind === SyntaxKind.ClassKeyword)
    )
      return true;
  }
  return false;
}

function isConditionalExpressionColon(tokens, colonIndex) {
  if (tokens[colonIndex - 1]?.kind === SyntaxKind.QuestionToken) return false;
  if (
    identifierLike(tokens[colonIndex - 1]) &&
    [SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken, SyntaxKind.SemicolonToken].includes(
      tokens[colonIndex - 2]?.kind,
    )
  )
    return !isTypeMemberScope(tokens, colonIndex - 1) && !isTypeDeclarationScope(tokens, colonIndex - 1);
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;
  for (let cursor = colonIndex - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.CloseParenToken) {
      parens += 1;
      continue;
    }
    if (kind === SyntaxKind.CloseBracketToken) {
      brackets += 1;
      continue;
    }
    if (kind === SyntaxKind.CloseBraceToken) {
      braces += 1;
      continue;
    }
    if (kind === SyntaxKind.GreaterThanToken) {
      angles += 1;
      continue;
    }
    if (kind === SyntaxKind.GreaterThanGreaterThanToken) {
      angles += 2;
      continue;
    }
    if (kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      angles += 3;
      continue;
    }
    if (kind === SyntaxKind.OpenParenToken) {
      if (parens > 0) parens -= 1;
      else return false;
      continue;
    }
    if (kind === SyntaxKind.OpenBracketToken) {
      if (brackets > 0) brackets -= 1;
      else return false;
      continue;
    }
    if (kind === SyntaxKind.OpenBraceToken) {
      if (braces > 0) braces -= 1;
      else return false;
      continue;
    }
    if (kind === SyntaxKind.LessThanToken) {
      if (angles > 0) angles -= 1;
      else return false;
      continue;
    }
    if (parens > 0 || brackets > 0 || braces > 0 || angles > 0) continue;
    if (kind === SyntaxKind.QuestionToken) return !isConditionalTypeQuestion(tokens, cursor);
    if ([SyntaxKind.CaseKeyword, SyntaxKind.DefaultKeyword].includes(kind)) return true;
    if (
      [
        SyntaxKind.ColonToken,
        SyntaxKind.CommaToken,
        SyntaxKind.SemicolonToken,
        SyntaxKind.EqualsToken,
        SyntaxKind.OpenBraceToken,
        SyntaxKind.CloseBraceToken,
      ].includes(kind)
    )
      return false;
  }
  return false;
}

function isTupleTypeArrow(tokens, arrowIndex) {
  const arrowClose = arrowIndex - 1;
  if (tokens[arrowClose]?.kind !== SyntaxKind.CloseParenToken) return false;
  const arrowOpen = matchingOpen(tokens, arrowClose, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
  if (arrowOpen === undefined) return false;
  const objectOpen = enclosingOpenBrace(tokens, arrowOpen);
  if (objectOpen !== undefined && isObjectLiteralOpen(tokens, objectOpen)) return false;
  for (let bracket = arrowOpen - 1; bracket >= 0; bracket -= 1) {
    if (tokens[bracket].kind !== SyntaxKind.OpenBracketToken) continue;
    const bracketClose = matching(tokens, bracket, SyntaxKind.OpenBracketToken, SyntaxKind.CloseBracketToken);
    if (bracketClose === undefined || arrowIndex >= bracketClose) continue;
    for (let cursor = bracket - 1; cursor >= 0; cursor -= 1) {
      const kind = tokens[cursor].kind;
      if (kind === SyntaxKind.ColonToken) return !isConditionalExpressionColon(tokens, cursor);
      if (
        [
          SyntaxKind.EqualsToken,
          SyntaxKind.CommaToken,
          SyntaxKind.SemicolonToken,
          SyntaxKind.OpenBraceToken,
          SyntaxKind.CloseBraceToken,
        ].includes(kind)
      )
        return false;
    }
    return false;
  }
  return false;
}

function identifierLike(token) {
  return token && (token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.ConstructorKeyword);
}

function isKeywordToken(token) {
  return token && token.kind >= SyntaxKind.FirstKeyword && token.kind <= SyntaxKind.LastKeyword;
}

function methodNameLike(token) {
  return (
    identifierLike(token) ||
    [
      SyntaxKind.PrivateIdentifier,
      SyntaxKind.StringLiteral,
      SyntaxKind.NumericLiteral,
      SyntaxKind.BigIntLiteral,
    ].includes(token?.kind) ||
    isKeywordToken(token)
  );
}

function looksLikeMethodName(tokens, nameIndex) {
  const previous = tokens[nameIndex - 1];
  if (!previous) return true;
  if ([SyntaxKind.DotToken, SyntaxKind.QuestionDotToken, SyntaxKind.AtToken].includes(previous.kind)) return false;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let cursor = nameIndex - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.CloseParenToken) parens += 1;
    else if (kind === SyntaxKind.OpenParenToken) {
      if (parens > 0) parens -= 1;
      else break;
    } else if (kind === SyntaxKind.CloseBracketToken) brackets += 1;
    else if (kind === SyntaxKind.OpenBracketToken) {
      if (brackets > 0) brackets -= 1;
      else break;
    } else if (kind === SyntaxKind.CloseBraceToken) braces += 1;
    else if (kind === SyntaxKind.OpenBraceToken) {
      if (braces > 0) braces -= 1;
      else break;
    } else if (parens === 0 && brackets === 0 && braces === 0 && kind === SyntaxKind.AtToken) return true;
    else if (
      parens === 0 &&
      brackets === 0 &&
      braces === 0 &&
      [SyntaxKind.SemicolonToken, SyntaxKind.CommaToken].includes(kind)
    )
      break;
  }
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
    SyntaxKind.OverrideKeyword,
    SyntaxKind.AsteriskToken,
  ].includes(previous.kind);
}

function isSemicolonlessClassMethod(tokens, nameIndex, bracePairs) {
  if (!isMemberContext(tokens, nameIndex)) return false;
  let parameterOpen = nameIndex + 1;
  if (
    [
      SyntaxKind.LessThanToken,
      SyntaxKind.GreaterThanToken,
      SyntaxKind.GreaterThanGreaterThanToken,
      SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
    ].includes(tokens[parameterOpen]?.kind)
  ) {
    const genericClose =
      tokens[parameterOpen]?.kind === SyntaxKind.LessThanToken
        ? matching(tokens, parameterOpen, SyntaxKind.LessThanToken, SyntaxKind.GreaterThanToken)
        : undefined;
    if (genericClose === undefined) return false;
    parameterOpen = genericClose + 1;
  }
  if (tokens[parameterOpen]?.kind !== SyntaxKind.OpenParenToken) return false;
  const parameterClose = matching(tokens, parameterOpen, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
  if (parameterClose === undefined) return false;
  const afterParameters = tokens[parameterClose + 1]?.kind;
  if (afterParameters !== SyntaxKind.OpenBraceToken && afterParameters !== SyntaxKind.ColonToken) return false;
  if (afterParameters === SyntaxKind.ColonToken && findBodyOpen(tokens, parameterClose, bracePairs) === undefined)
    return false;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let cursor = nameIndex - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.CloseParenToken) parens += 1;
    else if (kind === SyntaxKind.OpenParenToken) {
      if (parens > 0) parens -= 1;
      else return false;
    } else if (kind === SyntaxKind.CloseBracketToken) brackets += 1;
    else if (kind === SyntaxKind.OpenBracketToken) {
      if (brackets > 0) brackets -= 1;
      else return false;
    } else if (kind === SyntaxKind.CloseBraceToken) braces += 1;
    else if (kind === SyntaxKind.OpenBraceToken) {
      if (braces > 0) braces -= 1;
      else return false;
    } else if (parens === 0 && brackets === 0 && braces === 0) {
      if (kind === SyntaxKind.EqualsToken) return true;
      if ([SyntaxKind.ExclamationToken, SyntaxKind.QuestionToken].includes(tokens[cursor - 1]?.kind)) return true;
      if (
        kind === SyntaxKind.ColonToken &&
        (methodNameLike(tokens[cursor - 1]) ||
          (tokens[cursor - 1]?.kind === SyntaxKind.CloseBracketToken && isComputedMemberName(tokens, cursor - 1)))
      ) {
        for (let parent = cursor - 2; parent >= 0; parent -= 1) {
          const parentKind = tokens[parent].kind;
          if (parentKind === SyntaxKind.DeclareKeyword) return true;
          if (parentKind === SyntaxKind.OpenBraceToken) return true;
          if (
            [
              SyntaxKind.SemicolonToken,
              SyntaxKind.CommaToken,
              SyntaxKind.CloseBraceToken,
              SyntaxKind.EqualsToken,
              SyntaxKind.OpenParenToken,
              SyntaxKind.FunctionKeyword,
              SyntaxKind.ReturnKeyword,
            ].includes(parentKind)
          )
            break;
        }
      }
      if ([SyntaxKind.SemicolonToken, SyntaxKind.CommaToken, SyntaxKind.OpenBraceToken].includes(kind)) return false;
    }
  }
  return false;
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

function isComputedMemberName(tokens, closeBracketIndex) {
  const openBracket = matchingOpen(
    tokens,
    closeBracketIndex,
    SyntaxKind.OpenBracketToken,
    SyntaxKind.CloseBracketToken,
  );
  return openBracket !== undefined && isClassMemberContext(tokens, openBracket);
}

function isClassMemberContext(tokens, index) {
  const open = enclosingOpenBrace(tokens, index);
  if (open === undefined) return false;
  for (let cursor = open - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.ClassKeyword) return true;
    if (
      [
        SyntaxKind.OpenBraceToken,
        SyntaxKind.CloseBraceToken,
        SyntaxKind.SemicolonToken,
        SyntaxKind.EqualsToken,
        SyntaxKind.EqualsGreaterThanToken,
        SyntaxKind.ConstKeyword,
        SyntaxKind.LetKeyword,
        SyntaxKind.VarKeyword,
        SyntaxKind.ReturnKeyword,
      ].includes(kind)
    )
      return false;
  }
  return false;
}

function enclosingDelimiterOpen(tokens, from) {
  const pairs = new Map([
    [SyntaxKind.CloseParenToken, SyntaxKind.OpenParenToken],
    [SyntaxKind.CloseBracketToken, SyntaxKind.OpenBracketToken],
    [SyntaxKind.CloseBraceToken, SyntaxKind.OpenBraceToken],
  ]);
  const depth = new Map();
  for (let cursor = from - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor]?.kind;
    const open = pairs.get(kind);
    if (open !== undefined) {
      depth.set(open, (depth.get(open) ?? 0) + 1);
      continue;
    }
    if (![...pairs.values()].includes(kind)) continue;
    const count = depth.get(kind) ?? 0;
    if (count > 0) depth.set(kind, count - 1);
    else return cursor;
  }
  return undefined;
}

function isDestructuringParameterList(tokens, braceOpen) {
  if (tokens[braceOpen]?.kind === SyntaxKind.OpenParenToken) {
    const parameterClose = matching(tokens, braceOpen, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    return (
      parameterClose !== undefined &&
      isFunctionLikeParameterList(tokens, braceOpen) &&
      [SyntaxKind.OpenBraceToken, SyntaxKind.ColonToken].includes(tokens[parameterClose + 1]?.kind)
    );
  }
  if (tokens[braceOpen - 1]?.kind !== SyntaxKind.OpenParenToken) return false;
  const parameterOpen = braceOpen - 1;
  const parameterClose = matching(tokens, parameterOpen, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
  if (parameterClose === undefined) return false;
  if (tokens[parameterClose + 1]?.kind === SyntaxKind.EqualsGreaterThanToken) return true;
  if (tokens[parameterOpen - 1]?.kind === SyntaxKind.CatchKeyword)
    return tokens[parameterClose + 1]?.kind === SyntaxKind.OpenBraceToken;
  return (
    isFunctionLikeParameterList(tokens, parameterOpen) &&
    [SyntaxKind.OpenBraceToken, SyntaxKind.ColonToken].includes(tokens[parameterClose + 1]?.kind)
  );
}

function isDestructuringBindingContext(tokens, index) {
  let open = enclosingOpenBrace(tokens, index);
  while (open !== undefined) {
    const before = tokens[open - 1]?.kind;
    if ([SyntaxKind.ConstKeyword, SyntaxKind.LetKeyword, SyntaxKind.VarKeyword].includes(before)) return true;
    if (tokens[open]?.kind === SyntaxKind.OpenParenToken && isDestructuringParameterList(tokens, open)) return true;
    if (before === SyntaxKind.OpenParenToken && isDestructuringParameterList(tokens, open)) return true;
    if (![SyntaxKind.ColonToken, SyntaxKind.CommaToken, SyntaxKind.OpenBracketToken].includes(before)) return false;
    open = enclosingDelimiterOpen(tokens, open);
  }
  return false;
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
  if (before === SyntaxKind.ColonToken) return true;
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
    if (identifierLike(tokens[parameterOpen - 1]) && looksLikeMethodName(tokens, parameterOpen - 1)) return true;
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
  return (
    (identifierLike(tokens[index - 1]) && tokens[index - 2]?.kind === SyntaxKind.AsKeyword) ||
    isSatisfiesTypeReference(tokens, index)
  );
}

function isSatisfiesTypeReference(tokens, index) {
  if (!identifierLike(tokens[index - 1])) return false;
  for (let cursor = index - 2; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.SatisfiesKeyword) return true;
    if (identifierLike(tokens[cursor]) || [SyntaxKind.DotToken, SyntaxKind.QuestionDotToken].includes(kind)) continue;
    return false;
  }
  return false;
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

function genericMethodNameIndex(tokens, closeAngleIndex, bracePairs) {
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
        if (tokens[nameIndex]?.kind === SyntaxKind.CloseBracketToken && isComputedMethodName(tokens, nameIndex))
          return nameIndex;
        return methodNameLike(tokens[nameIndex]) &&
          (looksLikeMethodName(tokens, nameIndex) || isSemicolonlessClassMethod(tokens, nameIndex, bracePairs))
          ? nameIndex
          : undefined;
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
  let context = open - 2;
  while (tokens[context]?.kind === SyntaxKind.OpenParenToken) context -= 1;
  if (tokens[context]?.kind === SyntaxKind.OpenBracketToken) {
    for (let cursor = context - 1; cursor >= 0; cursor -= 1) {
      const kind = tokens[cursor]?.kind;
      if (kind === SyntaxKind.ColonToken) return !isConditionalExpressionColon(tokens, cursor);
      if (
        [
          SyntaxKind.EqualsToken,
          SyntaxKind.CommaToken,
          SyntaxKind.SemicolonToken,
          SyntaxKind.OpenBraceToken,
          SyntaxKind.CloseBraceToken,
        ].includes(kind)
      )
        return false;
    }
    return false;
  }
  return [
    SyntaxKind.ColonToken,
    SyntaxKind.BarToken,
    SyntaxKind.AmpersandToken,
    SyntaxKind.LessThanToken,
    SyntaxKind.CommaToken,
    SyntaxKind.OpenBracketToken,
    SyntaxKind.SatisfiesKeyword,
  ].includes(tokens[context]?.kind);
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
  if ([SyntaxKind.AsKeyword, SyntaxKind.SatisfiesKeyword].includes(tokens[open - 1]?.kind)) return true;
  if (isFunctionTypeParameterArrow(tokens, arrowIndex)) return true;
  if (isMethodTypeParameterArrow(tokens, arrowIndex)) return true;
  if (isClassTypeParameterArrow(tokens, arrowIndex)) return true;
  if (isTupleTypeArrow(tokens, arrowIndex)) return true;
  if (tokens[open - 1]?.kind === SyntaxKind.ColonToken) return !isConditionalExpressionColon(tokens, open - 1);
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
        const operatorKeywordBrace =
          [SyntaxKind.ExtendsKeyword, SyntaxKind.KeyOfKeyword, SyntaxKind.ReadonlyKeyword].includes(previousKind) &&
          ![SyntaxKind.DotToken, SyntaxKind.QuestionDotToken].includes(tokens[index - 2]?.kind);
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
            SyntaxKind.QuestionToken,
          ].includes(previousKind) ||
          operatorKeywordBrace;
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

function findArrowBindingName(tokens, equalsIndex) {
  for (let cursor = equalsIndex - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.ColonToken) {
      const optionalMarker = tokens[cursor - 1]?.kind === SyntaxKind.QuestionToken;
      const nameIndex = cursor - (optionalMarker ? 2 : 1);
      const name = tokens[nameIndex];
      if (isDestructuringBindingContext(tokens, cursor)) {
        const binding = tokens[cursor + 1];
        return bindingNameLike(binding) ? binding.text : undefined;
      }
      if (name?.kind === SyntaxKind.CloseBracketToken) {
        if (isComputedMemberName(tokens, nameIndex)) return '<computed>';
        const binding = tokens[cursor + 1];
        return bindingNameLike(binding) ? binding.text : undefined;
      }
      return bindingNameLike(name) ? name.text : undefined;
    }
    const closeOpenPairs = [
      [SyntaxKind.CloseParenToken, SyntaxKind.OpenParenToken],
      [SyntaxKind.CloseBracketToken, SyntaxKind.OpenBracketToken],
      [SyntaxKind.CloseBraceToken, SyntaxKind.OpenBraceToken],
    ];
    const pair = closeOpenPairs.find(([close]) => close === kind);
    if (pair) {
      const open = matchingOpen(tokens, cursor, pair[1], pair[0]);
      if (open === undefined) return undefined;
      cursor = open;
      continue;
    }
    if (
      [
        SyntaxKind.GreaterThanToken,
        SyntaxKind.GreaterThanGreaterThanToken,
        SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ].includes(kind)
    ) {
      const open = matchingAngleOpen(tokens, cursor);
      if (open === undefined) return undefined;
      cursor = open;
      continue;
    }
    if (
      [
        SyntaxKind.ConstKeyword,
        SyntaxKind.LetKeyword,
        SyntaxKind.VarKeyword,
        SyntaxKind.CommaToken,
        SyntaxKind.SemicolonToken,
        SyntaxKind.OpenBraceToken,
        SyntaxKind.ReturnKeyword,
      ].includes(kind)
    )
      return undefined;
  }
  return undefined;
}

function bindingNameLike(token) {
  return methodNameLike(token);
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
  while (tokens[cursor]?.kind === SyntaxKind.OpenParenToken) cursor -= 1;
  if (tokens[cursor]?.kind === SyntaxKind.EqualsToken) {
    const binding = findArrowBindingName(tokens, cursor);
    if (binding) return binding;
    if (bindingNameLike(tokens[cursor - 1])) return tokens[cursor - 1].text;
  }
  if (tokens[cursor - 1]?.kind === SyntaxKind.EqualsToken) {
    const binding = findArrowBindingName(tokens, cursor - 1);
    if (binding) return binding;
    if (bindingNameLike(tokens[cursor - 2])) return tokens[cursor - 2].text;
  }
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

function isMemberPropertyAccess(tokens, index) {
  return [SyntaxKind.DotToken, SyntaxKind.QuestionDotToken].includes(tokens[index - 1]?.kind);
}

function isPostfixNonNullAssertion(tokens, index) {
  if (tokens[index]?.kind !== SyntaxKind.ExclamationToken) return false;
  return canEndExpression(tokens[index - 1]) || isMemberPropertyAccess(tokens, index - 1);
}

function isTypeAssertionKeyword(tokens, index) {
  if (isGenericTypeAssertionEnd(tokens, index)) return true;
  if (!isPrimitiveTypeKeyword(tokens[index]?.kind)) return false;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.AsKeyword) return true;
    if (
      kind === SyntaxKind.BarToken ||
      kind === SyntaxKind.AmpersandToken ||
      kind === SyntaxKind.DotToken ||
      kind === SyntaxKind.QuestionDotToken ||
      isPrimitiveTypeKeyword(kind) ||
      identifierLike(tokens[cursor])
    )
      continue;
    return false;
  }
  return false;
}

function isGenericTypeAssertionEnd(tokens, index) {
  if (
    ![
      SyntaxKind.GreaterThanToken,
      SyntaxKind.GreaterThanGreaterThanToken,
      SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
    ].includes(tokens[index]?.kind)
  )
    return false;
  const open = matchingAngleOpen(tokens, index);
  if (open === undefined) return false;
  const previous = tokens[open - 1];
  const firstArgument = tokens[open + 1];
  const lastArgument = tokens[index - 1];
  if (!identifierLike(previous) || !firstArgument || !lastArgument) return false;
  for (let cursor = open - 1; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.AsKeyword) return true;
    if (
      isPrimitiveTypeKeyword(kind) ||
      identifierLike(tokens[cursor]) ||
      [
        SyntaxKind.TrueKeyword,
        SyntaxKind.FalseKeyword,
        SyntaxKind.NumericLiteral,
        SyntaxKind.StringLiteral,
        SyntaxKind.BigIntLiteral,
        SyntaxKind.NoSubstitutionTemplateLiteral,
      ].includes(kind)
    )
      continue;
    if ([SyntaxKind.MinusToken, SyntaxKind.PlusToken].includes(kind)) continue;
    if (
      [SyntaxKind.BarToken, SyntaxKind.AmpersandToken, SyntaxKind.DotToken, SyntaxKind.QuestionDotToken].includes(kind)
    )
      continue;
    return false;
  }
  return false;
}

function matchingAngleOpen(tokens, closeIndex) {
  let depth = 0;
  for (let cursor = closeIndex; cursor >= 0; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.GreaterThanToken) depth += 1;
    else if (kind === SyntaxKind.GreaterThanGreaterThanToken) depth += 2;
    else if (kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) depth += 3;
    else if (kind === SyntaxKind.LessThanToken) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return undefined;
}

function isPrimitiveTypeKeyword(kind) {
  return [
    SyntaxKind.AnyKeyword,
    SyntaxKind.BigIntKeyword,
    SyntaxKind.BooleanKeyword,
    SyntaxKind.NeverKeyword,
    SyntaxKind.NullKeyword,
    SyntaxKind.NumberKeyword,
    SyntaxKind.ObjectKeyword,
    SyntaxKind.StringKeyword,
    SyntaxKind.SymbolKeyword,
    SyntaxKind.UndefinedKeyword,
    SyntaxKind.UnknownKeyword,
    SyntaxKind.VoidKeyword,
  ].includes(kind);
}

function isKeywordNamedProperty(tokens, index) {
  return (
    [
      SyntaxKind.IfKeyword,
      SyntaxKind.ForKeyword,
      SyntaxKind.WhileKeyword,
      SyntaxKind.DoKeyword,
      SyntaxKind.CatchKeyword,
      SyntaxKind.CaseKeyword,
    ].includes(tokens[index]?.kind) && tokens[index + 1]?.kind === SyntaxKind.ColonToken
  );
}

function isConditionalTypeQuestion(tokens, index, start = 0) {
  if (tokens[index]?.kind !== SyntaxKind.QuestionToken) return false;
  let sawExtends = false;
  let extendsIndex;
  for (let cursor = index - 1; cursor >= start; cursor -= 1) {
    const kind = tokens[cursor].kind;
    if (kind === SyntaxKind.ExtendsKeyword) {
      if ([SyntaxKind.DotToken, SyntaxKind.QuestionDotToken].includes(tokens[cursor - 1]?.kind)) return false;
      sawExtends = true;
      extendsIndex = cursor;
      continue;
    }
    if (kind === SyntaxKind.TypeKeyword) return sawExtends;
    if (kind === SyntaxKind.ColonToken && sawExtends) {
      const angleOpen = extendsIndex === undefined ? undefined : enclosingAngleOpen(tokens, extendsIndex, start);
      if (angleOpen !== undefined) {
        const angleClose = matchingAngleClose(tokens, angleOpen);
        if (angleClose !== undefined) {
          if (index < angleClose) return true;
          sawExtends = false;
          continue;
        }
      }
      return true;
    }
    if (kind === SyntaxKind.LessThanToken && sawExtends && isConditionalTypeAngleStart(tokens, cursor)) {
      const angleClose = matchingAngleClose(tokens, cursor);
      if (angleClose === undefined) return false;
      if (index >= angleClose) {
        if (extendsIndex !== undefined && extendsIndex < angleClose) sawExtends = false;
        continue;
      }
      let angleDepth = 0;
      const assertionAngle = isConditionalTypeAssertionPrefix(tokens, cursor);
      for (let boundary = cursor; boundary < tokens.length; boundary += 1) {
        const boundaryKind = tokens[boundary].kind;
        if (boundaryKind === SyntaxKind.LessThanToken) angleDepth += 1;
        else if (boundaryKind === SyntaxKind.GreaterThanToken) angleDepth -= 1;
        else if (boundaryKind === SyntaxKind.GreaterThanGreaterThanToken) angleDepth -= 2;
        else if (boundaryKind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) angleDepth -= 3;
        if (angleDepth === 0) {
          if (
            assertionAngle ||
            boundary + 1 >= tokens.length ||
            [
              SyntaxKind.OpenParenToken,
              SyntaxKind.SemicolonToken,
              SyntaxKind.CommaToken,
              SyntaxKind.CloseParenToken,
              SyntaxKind.CloseBracketToken,
              SyntaxKind.CloseBraceToken,
              SyntaxKind.DotToken,
              SyntaxKind.QuestionDotToken,
              SyntaxKind.EqualsToken,
            ].includes(tokens[boundary + 1]?.kind)
          )
            return true;
          break;
        }
      }
    }
    if (kind === SyntaxKind.SemicolonToken) return false;
  }
  return false;
}

function isConditionalTypeAngleStart(tokens, index) {
  const assertionPrefix = isConditionalTypeAssertionPrefix(tokens, index);
  if (!identifierLike(tokens[index - 1]) && !assertionPrefix) return false;
  const first = tokens[index + 1];
  const afterFirst = tokens[index + 2]?.kind;
  if (identifierLike(first)) {
    if ([SyntaxKind.DotToken, SyntaxKind.QuestionDotToken].includes(afterFirst)) {
      let cursor = index + 2;
      while ([SyntaxKind.DotToken, SyntaxKind.QuestionDotToken].includes(tokens[cursor]?.kind)) {
        if (!identifierLike(tokens[cursor + 1])) return false;
        cursor += 2;
      }
      return tokens[cursor]?.kind === SyntaxKind.ExtendsKeyword;
    }
    if (afterFirst === SyntaxKind.OpenParenToken) return false;
    return true;
  }
  if (first?.kind === SyntaxKind.OpenBraceToken) {
    const close = matching(tokens, index + 1, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken);
    return close !== undefined && tokens[close + 1]?.kind === SyntaxKind.ExtendsKeyword;
  }
  if (first?.kind === SyntaxKind.OpenBracketToken) {
    const close = matching(tokens, index + 1, SyntaxKind.OpenBracketToken, SyntaxKind.CloseBracketToken);
    return close !== undefined && tokens[close + 1]?.kind === SyntaxKind.ExtendsKeyword;
  }
  if (first?.kind === SyntaxKind.OpenParenToken) {
    const close = matching(tokens, index + 1, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    return close !== undefined && tokens[close + 1]?.kind === SyntaxKind.ExtendsKeyword;
  }
  if ([SyntaxKind.MinusToken, SyntaxKind.PlusToken].includes(first?.kind))
    return (
      [SyntaxKind.NumericLiteral, SyntaxKind.BigIntLiteral].includes(tokens[index + 2]?.kind) &&
      tokens[index + 3]?.kind === SyntaxKind.ExtendsKeyword
    );
  if (
    [
      SyntaxKind.AnyKeyword,
      SyntaxKind.BigIntKeyword,
      SyntaxKind.BooleanKeyword,
      SyntaxKind.NeverKeyword,
      SyntaxKind.NullKeyword,
      SyntaxKind.NumberKeyword,
      SyntaxKind.ObjectKeyword,
      SyntaxKind.StringKeyword,
      SyntaxKind.SymbolKeyword,
      SyntaxKind.ThisKeyword,
      SyntaxKind.UndefinedKeyword,
      SyntaxKind.UnknownKeyword,
      SyntaxKind.VoidKeyword,
    ].includes(first?.kind)
  )
    return afterFirst === SyntaxKind.ExtendsKeyword;
  if (
    [
      SyntaxKind.TrueKeyword,
      SyntaxKind.FalseKeyword,
      SyntaxKind.NumericLiteral,
      SyntaxKind.StringLiteral,
      SyntaxKind.BigIntLiteral,
      SyntaxKind.NoSubstitutionTemplateLiteral,
    ].includes(first?.kind)
  )
    return afterFirst === SyntaxKind.ExtendsKeyword;
  return [
    SyntaxKind.KeyOfKeyword,
    SyntaxKind.TypeOfKeyword,
    SyntaxKind.InferKeyword,
    SyntaxKind.ReadonlyKeyword,
    SyntaxKind.UniqueKeyword,
  ].includes(first?.kind);
}

function isConditionalTypeAssertionPrefix(tokens, index) {
  const previousKind = tokens[index - 1]?.kind;
  return (
    isBinaryOperator(previousKind) ||
    [
      SyntaxKind.ReturnKeyword,
      SyntaxKind.ThrowKeyword,
      SyntaxKind.AwaitKeyword,
      SyntaxKind.YieldKeyword,
      SyntaxKind.ExclamationToken,
      SyntaxKind.TildeToken,
      SyntaxKind.VoidKeyword,
      SyntaxKind.TypeOfKeyword,
      SyntaxKind.DeleteKeyword,
      SyntaxKind.EqualsGreaterThanToken,
      SyntaxKind.OpenBraceToken,
      SyntaxKind.OpenParenToken,
      SyntaxKind.OpenBracketToken,
      SyntaxKind.ColonToken,
      SyntaxKind.QuestionToken,
    ].includes(previousKind)
  );
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
      signatureStart: start,
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
      let parameterSearchStart = nameIndex;
      const genericStart = named ? nameIndex + 1 : nameIndex;
      if (tokens[genericStart]?.kind === SyntaxKind.LessThanToken) {
        const genericClose = matchingAngleClose(tokens, genericStart);
        if (genericClose === undefined) continue;
        parameterSearchStart = genericClose + 1;
      }
      const parameterOpen = tokens.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex >= parameterSearchStart && candidate.kind === SyntaxKind.OpenParenToken,
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
      const parameterClose = findArrowParameterClose(tokens, index);
      const parameterOpen =
        parameterClose === undefined
          ? undefined
          : matchingOpen(tokens, parameterClose, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
      const signatureStart = parameterOpen ?? index - 1;
      if (tokens[index + 1]?.kind === SyntaxKind.OpenBraceToken) {
        const bodyOpen = index + 1;
        add(signatureStart, { bodyOpen, bodyClose: braces.get(bodyOpen) }, name);
      } else {
        add(
          signatureStart,
          { expressionStart: index + 1, expressionEnd: findArrowExpressionEnd(tokens, index + 1) },
          name,
        );
      }
      continue;
    }
    if (token.kind !== SyntaxKind.OpenParenToken) continue;
    const nameIndex = index - 1;
    let name;
    if (
      methodNameLike(tokens[nameIndex]) &&
      (looksLikeMethodName(tokens, nameIndex) || isSemicolonlessClassMethod(tokens, nameIndex, braces)) &&
      (!isKeywordToken(tokens[nameIndex]) || isMemberContext(tokens, nameIndex))
    )
      name = tokens[nameIndex].text;
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
      const genericName = genericMethodNameIndex(tokens, nameIndex, braces);
      if (genericName === undefined) continue;
      name = tokens[genericName].kind === SyntaxKind.CloseBracketToken ? '<computed>' : tokens[genericName].text;
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
          (candidate.signatureStart === index || candidate.bodyOpen === index || candidate.expressionStart === index) &&
          candidate !== entry &&
          (candidate.bodyClose ?? candidate.expressionEnd) <= end,
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
          !isMemberPropertyAccess(tokens, index) &&
          !isKeywordNamedProperty(tokens, index) &&
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
    delete entry.signatureStart;
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
      expected: [{ name: 'typed', complexity: 1 }],
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
      source: `class SemicolonlessField {
        field = setup()
        check(ready) { if (ready) return true; return false; }
      }`,
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source: `class SemicolonlessLiteralField {
        field = 1
        check(ready) { if (ready) return true; return false; }
      }`,
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source: `class SemicolonlessGenericField {
        field = 1
        check<T>(ready: T) { if (ready) return true; return false; }
      }`,
      expected: [{ name: 'check', complexity: 2 }],
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
      source: `class TypedMethod {
        load(value: T): Promise<Result> {
          for (const item of value) if (item) return item;
          return value;
        }
      }`,
      expected: [{ name: 'load', complexity: 3 }],
    },
    {
      source: `class PrivateMethod {
        #check(ready) { if (ready) return true; return false; }
      }`,
      expected: [{ name: '#check', complexity: 2 }],
    },
    {
      source: `class GenericPrivateMethod {
        #check<T>(ready: T) { if (ready) return true; return false; }
      }`,
      expected: [{ name: '#check', complexity: 2 }],
    },
    {
      source: `class PropertyNameMethods {
        "check"() { if (ready) return true; }
        42() { if (ready) return true; }
        return() { if (ready) return true; }
      }`,
      expected: [
        { name: '"check"', complexity: 2 },
        { name: '42', complexity: 2 },
        { name: 'return', complexity: 2 },
      ],
    },
    {
      source: `class OverrideMethods {
        override check() { if (ready) return true; }
        public override checkAgain() { if (ready) return true; }
      }`,
      expected: [
        { name: 'check', complexity: 2 },
        { name: 'checkAgain', complexity: 2 },
      ],
    },
    {
      source: `function inlineOptionalType(value) {
        const hooks: { ready?(): boolean } = value;
        if (value) return hooks;
        return undefined;
      }`,
      expected: [{ name: 'inlineOptionalType', complexity: 2 }],
    },
    {
      source: `function instantiationConditional(value) {
        const specialized = factory<T extends string ? A : B>;
        if (value) return specialized;
        return undefined;
      }`,
      expected: [{ name: 'instantiationConditional', complexity: 2 }],
    },
    {
      source: 'const satisfiesConditional = () => value satisfies Pair<A, B> && ready;',
      expected: [{ name: 'satisfiesConditional', complexity: 2 }],
    },
    {
      source: 'const qualifiedSatisfies = () => value satisfies Types.Pair<A, B> && ready;',
      expected: [{ name: 'qualifiedSatisfies', complexity: 2 }],
    },
    {
      source: 'function controlRegex(value) { if (value) /a&&b/u.test(value); return value; }',
      expected: [{ name: 'controlRegex', complexity: 2 }],
    },
    {
      source: 'function memberCallDivision(value) { obj.if(value) / 2 && value / 3; return value; }',
      expected: [{ name: 'memberCallDivision', complexity: 2 }],
    },
    {
      source: 'function memberPropertyDivision(value) { return obj.if / 2 && value / 3; }',
      expected: [{ name: 'memberPropertyDivision', complexity: 2 }],
    },
    {
      source: 'function nonNullDivision(value) { return value! / 2 && other / 3; }',
      expected: [{ name: 'nonNullDivision', complexity: 2 }],
    },
    {
      source: 'function primitiveAssertionDivision(value) { return value as number / 2 && other / 3; }',
      expected: [{ name: 'primitiveAssertionDivision', complexity: 2 }],
    },
    {
      source: 'function unionAssertionDivision(value) { return value as number | undefined / 2 && other / 3; }',
      expected: [{ name: 'unionAssertionDivision', complexity: 2 }],
    },
    {
      source:
        'function qualifiedUnionAssertionDivision(value) { return value as Foo.Bar | undefined / 2 && other / 3; }',
      expected: [{ name: 'qualifiedUnionAssertionDivision', complexity: 2 }],
    },
    {
      source: 'function genericAssertionDivision(value) { return value as Numeric<Tag> / 2 && other / 3; }',
      expected: [{ name: 'genericAssertionDivision', complexity: 2 }],
    },
    {
      source:
        'function relationalGenericAssertion(value, threshold, text, yes, no) { return value as Foo < threshold > /a&&b/.test(text) ? yes : no; }',
      expected: [{ name: 'relationalGenericAssertion', complexity: 2 }],
    },
    {
      source: 'function spacedGenericAssertion(value) { return value as Numeric <Tag> / 2 && other / 3; }',
      expected: [{ name: 'spacedGenericAssertion', complexity: 2 }],
    },
    {
      source: 'function bothSidedTriviaGenericAssertion(value) { return value as Numeric < Tag > / 2 && other / 3; }',
      expected: [{ name: 'bothSidedTriviaGenericAssertion', complexity: 2 }],
    },
    {
      source:
        'function chainedDivisionAfterAssertion(value, a, b, ready) { return value as number / (a && b) / -3 && ready; }',
      expected: [{ name: 'chainedDivisionAfterAssertion', complexity: 3 }],
    },
    {
      source:
        'function genericUnionAssertionDivision(value) { return value as number | Numeric<Tag> / 2 && other / 3; }',
      expected: [{ name: 'genericUnionAssertionDivision', complexity: 2 }],
    },
    {
      source:
        'function genericNullableUnionAssertionDivision(value) { return value as null | Numeric<Tag> / 2 && other / 3; }',
      expected: [{ name: 'genericNullableUnionAssertionDivision', complexity: 2 }],
    },
    {
      source: 'function literalUnionAssertionDivision(value) { return value as true | Numeric<Tag> / 2 && other / 3; }',
      expected: [{ name: 'literalUnionAssertionDivision', complexity: 2 }],
    },
    {
      source: 'function bigintDivision() { return 1n / 2n && other / 3n; }',
      expected: [{ name: 'bigintDivision', complexity: 2 }],
    },
    {
      source:
        'function runtimeExtendsProperty(flags, first, second) { return { choice: flags.extends ? first : second }; }',
      expected: [{ name: 'runtimeExtendsProperty', complexity: 2 }],
    },
    {
      source: 'class DecoratedMethods { @logged check(ready) { if (ready) return true; } }',
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source: 'class InvokedDecoratedMethods { @logged() check(ready) { if (ready) return true; } }',
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source:
        'function signedLiteralUnionAssertionDivision(value) { return value as -1 | Numeric<Tag> / 2 && other / 3; }',
      expected: [{ name: 'signedLiteralUnionAssertionDivision', complexity: 2 }],
    },
    {
      source:
        'function pairedComparison(value, flags, first, second, minimum) { return value < flags.extends ? first : second > (minimum); }',
      expected: [{ name: 'pairedComparison', complexity: 2 }],
    },
    {
      source: 'function keyofConditional(value) { return factory<keyof T extends string ? A : B>() || value; }',
      expected: [{ name: 'keyofConditional', complexity: 2 }],
    },
    {
      source: 'const curry = (x) => (y) => x && y;',
      expected: [
        { name: 'curry', complexity: 1 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: 'function keywordProperties(value, ready) { return { if: value && ready, while: value || ready }; }',
      expected: [{ name: 'keywordProperties', complexity: 3 }],
    },
    {
      source:
        'function structuredConditional(value) { return factory<{ value: T } extends Foo ? A : B>() || factory<[T] extends Foo ? C : D>() || value; }',
      expected: [{ name: 'structuredConditional', complexity: 3 }],
    },
    {
      source:
        "function literalConditional(value) { return factory<true extends boolean ? A : B>() || factory<'ready' extends string ? C : D>() || factory<42 extends number ? E : F>() || value; }",
      expected: [{ name: 'literalConditional', complexity: 4 }],
    },
    {
      source: 'function signedConditional(value) { return factory<-1 extends number ? A : B>() || value; }',
      expected: [{ name: 'signedConditional', complexity: 2 }],
    },
    {
      source: 'function runtimeAfterConditionalType(value) { return factory<T extends U ? A : B>() ? yes : no; }',
      expected: [{ name: 'runtimeAfterConditionalType', complexity: 2 }],
    },
    {
      source:
        'function objectPropertyAfterConditionalType(value) { return { x: factory<T extends U ? A : B>() ? yes : no }; }',
      expected: [{ name: 'objectPropertyAfterConditionalType', complexity: 2 }],
    },
    {
      source: 'function parenthesizedConditional(value) { return factory<(T) extends Foo ? A : B>() || value; }',
      expected: [{ name: 'parenthesizedConditional', complexity: 2 }],
    },
    {
      source:
        'function conditionalReturnType<T>(): T extends string ? { ok: true } : { ok: false } { if (ready) return 1; }',
      expected: [{ name: 'conditionalReturnType', complexity: 2 }],
    },
    {
      source: `function nestedParameterHost() {
        return function nestedParameter(value = ready && fallback) { return value; };
      }`,
      expected: [
        { name: 'nestedParameterHost', complexity: 1 },
        { name: 'nestedParameter', complexity: 1 },
      ],
    },
    {
      source: 'function primitiveConditional(value) { return factory<string extends Foo ? A : B>() || value; }',
      expected: [{ name: 'primitiveConditional', complexity: 2 }],
    },
    {
      source:
        'function keywordConditional(value) { return factory<unknown extends Foo ? A : B>() || factory<any extends Foo ? A : B>() || value; }',
      expected: [{ name: 'keywordConditional', complexity: 3 }],
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
      source: 'function keyofReturn(): keyof { ready: boolean } { if (ready) return true; }',
      expected: [{ name: 'keyofReturn', complexity: 2 }],
    },
    {
      source: 'function readonlyReturn(): readonly { ready: boolean }[] { if (ready) return []; }',
      expected: [{ name: 'readonlyReturn', complexity: 2 }],
    },
    {
      source: 'function readonlyMemberReturn(): typeof obj.readonly { if (ready) return true; }',
      expected: [{ name: 'readonlyMemberReturn', complexity: 2 }],
    },
    {
      source: 'function keyofMemberReturn(): typeof obj.keyof { if (ready) return true; }',
      expected: [{ name: 'keyofMemberReturn', complexity: 2 }],
    },
    {
      source: 'function extendsMemberReturn(): typeof obj.extends { if (ready) return true; }',
      expected: [{ name: 'extendsMemberReturn', complexity: 2 }],
    },
    {
      source: `class DeclarationOnlyField {
        field!: number
        check(ready) { if (ready) return true; return false; }
      }`,
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source: `class DeclaredField {
        declare field: number
        check(ready) { if (ready) return true; return false; }
      }`,
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source: `class DeclaredLiteralField {
        declare "field": number
        check(ready) { if (ready) return true; return false; }
      }`,
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source: `class DeclaredComputedField {
        declare ["field"]: number
        check(ready) { if (ready) return true; return false; }
      }`,
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source: 'function constrained<T>(): T extends { ready: boolean } ? string : number { if (ready) return true; }',
      expected: [{ name: 'constrained', complexity: 2 }],
    },
    {
      source:
        'function callableConstraint<T extends (value: string) => boolean>(ready: boolean) { if (ready) return true; }',
      expected: [{ name: 'callableConstraint', complexity: 2 }],
    },
    {
      source:
        'export default function <T extends (value: string) => boolean>(ready: boolean) { if (ready) return true; }',
      expected: [{ name: '<anonymous>', complexity: 2 }],
    },
    {
      source: 'function qualifiedConditional() { return factory<Types.T extends Foo ? A : B>() || value; }',
      expected: [{ name: 'qualifiedConditional', complexity: 2 }],
    },
    {
      source: 'function defaultArrow(callback = () => ready ? first : second) { return callback; }',
      expected: [
        { name: 'defaultArrow', complexity: 1 },
        { name: 'callback', complexity: 2 },
      ],
    },
    {
      source: 'const cb: Handler = () => ready ? first : second;',
      expected: [{ name: 'cb', complexity: 2 }],
    },
    {
      source: 'class PrivateTypedField { #cb: Handler = () => ready ? first : second; }',
      expected: [{ name: '#cb', complexity: 2 }],
    },
    {
      source: 'class OptionalTypedField { cb?: Handler = () => ready ? first : second; }',
      expected: [{ name: 'cb', complexity: 2 }],
    },
    {
      source: 'class OptionalLiteralTypedField { "cb"?: Handler = () => ready ? first : second; }',
      expected: [{ name: '"cb"', complexity: 2 }],
    },
    {
      source: 'function tupleCallback(callback: [() => boolean]) { return callback; }',
      expected: [{ name: 'tupleCallback', complexity: 1 }],
    },
    {
      source: 'const config = { handlers: [() => ready ? first : second] };',
      expected: [{ name: '<arrow>', complexity: 2 }],
    },
    {
      source: 'function conditionalArray() { return choose ? existing : [() => ready ? first : second]; }',
      expected: [
        { name: 'conditionalArray', complexity: 2 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: 'function conditionalDirectArrow() { return choose ? existing : () => ready ? first : second; }',
      expected: [
        { name: 'conditionalDirectArrow', complexity: 2 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: 'function switchArray(value) { switch (value) { case 1: return [() => ready ? first : second]; } }',
      expected: [
        { name: 'switchArray', complexity: 2 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: 'function labeledArray() { label: return [() => ready ? first : second]; }',
      expected: [
        { name: 'labeledArray', complexity: 1 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: 'function nestedTuple(callback: { handlers: [() => boolean] }) { return callback; }',
      expected: [{ name: 'nestedTuple', complexity: 1 }],
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
      source: `class GenericComputedMethod {
        [key]<T>(ready: T) { if (ready) return value; return undefined; }
      }`,
      expected: [{ name: '<computed>', complexity: 2 }],
    },
    {
      source: `class CallableConstraintMethod {
        method<T extends (value: string) => boolean>(value: T) { if (value) return value; }
      }`,
      expected: [{ name: 'method', complexity: 2 }],
    },
    {
      source: `class CallableConstraintClass<T extends () => boolean> {
        check(ready) { if (ready) return true; }
      }`,
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source: `class NestedCallableConstraintClass<T extends Wrapper<() => boolean>> {
        check(ready) { if (ready) return true; }
      }`,
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source: `const AnonymousCallableConstraintClass = class<T extends Wrapper<() => boolean>> {
        check(ready) { if (ready) return true; }
      }`,
      expected: [{ name: 'check', complexity: 2 }],
    },
    {
      source: 'class ComputedTypedField { ["cb"]: Handler = () => ready ? first : second; }',
      expected: [{ name: '<computed>', complexity: 2 }],
    },
    {
      source: 'const { ["cb"]: cb = () => ready ? first : second } = source;',
      expected: [{ name: 'cb', complexity: 2 }],
    },
    {
      source: 'const { property: cb = () => ready ? first : second } = source;',
      expected: [{ name: 'cb', complexity: 2 }],
    },
    {
      source: 'const satisfied = (() => true) satisfies () => boolean;',
      expected: [{ name: 'satisfied', complexity: 1 }],
    },
    {
      source: 'const satisfiedWrapped = (() => true) satisfies (() => boolean);',
      expected: [{ name: 'satisfiedWrapped', complexity: 1 }],
    },
    {
      source: 'const satisfiedDoubleWrapped = (() => true) satisfies ((() => boolean));',
      expected: [{ name: 'satisfiedDoubleWrapped', complexity: 1 }],
    },
    {
      source:
        'const genericCallable = <T extends (value: string) => boolean>(value: T) => value("x") ? first : second;',
      expected: [{ name: 'genericCallable', complexity: 2 }],
    },
    {
      source:
        'const parenthesizedGenericCallable = (<T extends (value: string) => boolean>(value: T) => value("x") ? first : second);',
      expected: [{ name: 'parenthesizedGenericCallable', complexity: 2 }],
    },
    {
      source: 'const doubleWrappedGenericCallable = ((<T extends () => boolean>(value: T) => value ? first : second));',
      expected: [{ name: 'doubleWrappedGenericCallable', complexity: 2 }],
    },
    {
      source: 'function destructuredParameter({ property: cb = () => ready ? first : second }) { return cb; }',
      expected: [
        { name: 'destructuredParameter', complexity: 1 },
        { name: 'cb', complexity: 2 },
      ],
    },
    {
      source: 'const { outer: { property: cb = () => ready ? first : second } } = source;',
      expected: [{ name: 'cb', complexity: 2 }],
    },
    {
      source: 'function destructuredAfterValue(value, { property: cb = () => ready ? first : second }) {}',
      expected: [
        { name: 'destructuredAfterValue', complexity: 1 },
        { name: 'cb', complexity: 2 },
      ],
    },
    {
      source: 'const handlers = [((() => ready ? first : second))];',
      expected: [{ name: 'handlers', complexity: 2 }],
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
      source: `function genericArrowReturn() {
        return <T extends () => boolean>(value: T) => value() ? first : second;
      }`,
      expected: [
        { name: 'genericArrowReturn', complexity: 1 },
        { name: '<arrow>', complexity: 2 },
      ],
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
    {
      source: 'const genericArrowWithObjectConstraint = <T extends keyof { cb: () => void }>(x: T) => x ? 1 : 2;',
      expected: [{ name: 'genericArrowWithObjectConstraint', complexity: 2 }],
    },
    {
      source: `function conditionalAssertion() {
        const x = <T extends U ? A : B>value;
        return x && y;
      }`,
      expected: [{ name: 'conditionalAssertion', complexity: 2 }],
    },
    {
      source: `function conditionalBranchAssertion() {
        return ready ? <T extends U ? A : B>value : fallback;
      }`,
      expected: [{ name: 'conditionalBranchAssertion', complexity: 2 }],
    },
    {
      source: `function logicalAssertion() {
        return ready && <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'logicalAssertion', complexity: 2 }],
    },
    {
      source: `function logicalOrAssertion() {
        return ready || <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'logicalOrAssertion', complexity: 2 }],
    },
    {
      source: `function nullishAssertion() {
        return ready ?? <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'nullishAssertion', complexity: 2 }],
    },
    {
      source: `function plusAssertion() {
        return ready + <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'plusAssertion', complexity: 1 }],
    },
    {
      source: `function minusAssertion() {
        return ready - <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'minusAssertion', complexity: 1 }],
    },
    {
      source: `function multiplyAssertion() {
        return ready * <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'multiplyAssertion', complexity: 1 }],
    },
    {
      source: `function remainderAssertion() {
        return ready % <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'remainderAssertion', complexity: 1 }],
    },
    {
      source: `function divisionAssertion() {
        return ready / <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'divisionAssertion', complexity: 1 }],
    },
    {
      source: `function exponentiationAssertion() {
        return ready ** <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'exponentiationAssertion', complexity: 1 }],
    },
    {
      source: `function bitwiseAssertion() {
        return ready & <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'bitwiseAssertion', complexity: 1 }],
    },
    {
      source: `async function awaitAssertion() {
        return await <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'awaitAssertion', complexity: 1 }],
    },
    {
      source: `function* yieldAssertion() {
        return yield <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'yieldAssertion', complexity: 1 }],
    },
    {
      source: `function unaryAssertion() {
        return !<T extends U ? A : B>value;
      }`,
      expected: [{ name: 'unaryAssertion', complexity: 1 }],
    },
    {
      source: `function tildeAssertion() {
        return ~<T extends U ? A : B>value;
      }`,
      expected: [{ name: 'tildeAssertion', complexity: 1 }],
    },
    {
      source: `function typeofAssertion() {
        return typeof <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'typeofAssertion', complexity: 1 }],
    },
    {
      source: `function voidAssertion() {
        return void <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'voidAssertion', complexity: 1 }],
    },
    {
      source: `function deleteAssertion() {
        return delete <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'deleteAssertion', complexity: 1 }],
    },
    {
      source: `const conciseAssertion = () => <T extends U ? A : B>value;`,
      expected: [{ name: 'conciseAssertion', complexity: 1 }],
    },
    {
      source: `function throwAssertion() {
        throw <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'throwAssertion', complexity: 1 }],
    },
    {
      source: `function expressionAssertion() {
        <T extends U ? A : B>value;
      }`,
      expected: [{ name: 'expressionAssertion', complexity: 1 }],
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
