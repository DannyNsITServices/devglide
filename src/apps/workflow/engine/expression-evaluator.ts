import type { ExecutionContext } from '../types.js';
import { VariableResolver } from './variable-resolver.js';

const resolver = new VariableResolver();

export function evaluate(expression: string, context: ExecutionContext): boolean {
  const resolved = resolver.resolve(expression, context);
  return evaluateExpression(resolved.trim());
}

function evaluateExpression(expr: string): boolean {
  const orParts = splitOutsideQuotes(expr, '||');
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateExpression(part.trim()));
  }

  const andParts = splitOutsideQuotes(expr, '&&');
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateExpression(part.trim()));
  }

  if (expr.startsWith('!') && !expr.startsWith('!=')) {
    return !evaluateExpression(expr.slice(1).trim());
  }

  return evaluateComparison(expr);
}

function evaluateComparison(expr: string): boolean {
  const operators = ['!=', '==', '>=', '<=', '>', '<', ' contains ', ' matches '] as const;

  for (const op of operators) {
    const idx = expr.indexOf(op);
    if (idx === -1) continue;

    const left = expr.slice(0, idx).trim();
    const right = expr.slice(idx + op.length).trim();
    const leftVal = parseValue(left);
    const rightVal = parseValue(right);

    switch (op.trim()) {
      case '==':
        return leftVal === rightVal;
      case '!=':
        return leftVal !== rightVal;
      case '>':
        return Number(leftVal) > Number(rightVal);
      case '<':
        return Number(leftVal) < Number(rightVal);
      case '>=':
        return Number(leftVal) >= Number(rightVal);
      case '<=':
        return Number(leftVal) <= Number(rightVal);
      case 'contains':
        return String(leftVal).includes(String(rightVal));
      case 'matches': {
        try {
          const pattern = String(rightVal);
          if (pattern.length > 200) return false;
          const regex = new RegExp(pattern);
          return regex.test(String(leftVal));
        } catch {
          return false;
        }
      }
    }
  }

  const val = parseValue(expr);
  return Boolean(val) && val !== '0' && val !== 'false' && val !== '';
}

function parseValue(raw: string): string | number {
  const trimmed = raw.trim();

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed !== '') {
    return num;
  }

  return trimmed;
}

function splitOutsideQuotes(str: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < str.length) {
    if (str[i] === '"' && !inSingle) {
      inDouble = !inDouble;
      current += str[i];
      i++;
    } else if (str[i] === "'" && !inDouble) {
      inSingle = !inSingle;
      current += str[i];
      i++;
    } else if (!inSingle && !inDouble && str.slice(i, i + delimiter.length) === delimiter) {
      parts.push(current);
      current = '';
      i += delimiter.length;
    } else {
      current += str[i];
      i++;
    }
  }

  parts.push(current);
  return parts;
}
