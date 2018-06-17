import * as _ from 'lodash';
import { parse as ReactDocgenParse, resolver as ReactDocgenResolver } from 'react-docgen';
import isReactComponentClass from './isReactComponentClass';
import isStatelessComponent from './isStatelessComponent';
import * as p from 'path';

export default function ({types: t}) {
  return {
    visitor: {
      Class(path, state) {
        if(!isReactComponentClass(path)) {
          return;
        }
        if(!path.node.id){
          return;
        }
        const className = path.node.id.name;

        if(!isExported(path, className, t)){
          return;
        }
        injectReactDocgenInfo(className, path, state, this.file.code, t);
      },
      'CallExpression'(path, state) {
        const callee = path.node.callee;

        const objectName = _.get(callee, 'object.name') ? callee.object.name.toLowerCase() : null;
        const propertyName = _.get(callee, 'property.name') ? callee.property.name.toLowerCase() : null;
        const calleeName = _.get(callee, 'name') ? callee.name.toLowerCase() : null;

        // Detect `React.createClass()`
        const hasReactCreateClass = (objectName === 'react' && propertyName === 'createclass');

        // Detect `createReactClass()`
        const hasCreateReactClass = (calleeName === 'createreactclass');

        // Get React class name from variable declaration
        const className = _.get(path, 'parentPath.parent.declarations[0].id.name');

        // Detect `React.createElement()`
        const hasReactCreateElement = (objectName === 'react' && propertyName === 'createelement');

        if (className && (hasReactCreateClass || hasCreateReactClass)) {
          injectReactDocgenInfo(className, path, state, this.file.code, t);
        }

        if (hasReactCreateElement) {
          const variableDeclaration = path.findParent((path) => path.isVariableDeclaration());

          if (variableDeclaration) {
            const elementClassName = variableDeclaration.node.declarations[0].id.name;
            if (!isExported(path, elementClassName, t)) {
              return;
            }

            injectReactDocgenInfo(elementClassName, path, state, this.file.code, t);
          }
        }
      },
      'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(path, state) {
        if (!isStatelessComponent(path)) {
          return;
        }

        const node = (path.node.type === 'FunctionDeclaration') ? path.node : path.parentPath.node;

        if (!node.id) {
          return;
        }
        const className = node.id.name;

        if (!isExported(path, className, t)) {
          return;
        }
        injectReactDocgenInfo(className, path, state, this.file.code, t);
      },
    }
  };
}

function isExported(path, className, t){
  const types = [
    'ExportDefaultDeclaration',
    'ExportNamedDeclaration'
  ];

  function findMostRightHandArgument(args = []) {
    const arg = args[0]
    if (t.isIdentifier(arg)) {
      return arg.name
    } else if(t.isCallExpression(arg)) {
      return findMostRightHandArgument(arg.arguments)
    }
  }

  if(path.parentPath.node &&
     types.some(type => {return path.parentPath.node.type === type;})) {
    return true;
  }

  const program = path.scope.getProgramParent().path;
  return program.get('body').some(path => {
    if(path.node.type === 'ExportNamedDeclaration') {
      if (path.node.specifiers && path.node.specifiers.length) {
        return className === path.node.specifiers[0].exported.name;
      } else if (path.node.declaration.declarations && path.node.declaration.declarations.length) {
        return className === path.node.declaration.declarations[0].id.name;
      }
    } else if(path.node.type === 'ExportDefaultDeclaration') {
      const decl = path.node.declaration
      if (t.isCallExpression(decl)) {
        return className === findMostRightHandArgument(decl.arguments);
      } else {
        return className === decl.name;
      }
    // Detect module.exports = className;
    } else if(path.node.type === 'ExpressionStatement') {
      const expr = path.node.expression

      if (t.isAssignmentExpression(expr)) {
        const left = expr.left;
        const right = expr.right;

        const leftIsModuleExports = t.isMemberExpression(left) &&
            t.isIdentifier(left.object) &&
            t.isIdentifier(left.property) &&
            left.object.name === 'module' &&
            left.property.name === 'exports';

        const rightIsIdentifierClass = t.isIdentifier(right) && right.name === className;

        return leftIsModuleExports && rightIsIdentifierClass;
      }
    }
    return false;
  });
}

function alreadyVisited(program, t) {
  return program.node.body.some(node => {
    if(t.isExpressionStatement(node) &&
       t.isAssignmentExpression(node.expression) &&
       t.isMemberExpression(node.expression.left)
      ) {
      return node.expression.left.property.name === '__docgenInfo';
    }
    return false;
  });
}


function injectReactDocgenInfo(className, path, state, code, t) {
  const program = path.scope.getProgramParent().path;

  if(alreadyVisited(program, t)) {
    return;
  }

  let docgenResults = [];
  try { // all exported component definitions includes named exports
    let resolver = ReactDocgenResolver.findAllExportedComponentDefinitions;

    if (state.opts.resolver) {
      resolver = ReactDocgenResolver[state.opts.resolver];
    }

    docgenResults = ReactDocgenParse(code, resolver);

    if (!state.opts.includeMethods) {
      docgenResults.forEach(function(docgenResult) {
        delete docgenResult.methods;
      })
    }
  } catch(e) {
    // this is for debugging the error only, do not ship this console log or else it pollutes the webpack output
    // console.log(e);
    return;
  }

  // docgen sometimes doesn't include 'displayName' which is the react function/class name
  // the first time it's not available, we try to match it to the export name
  let isDefaultClassNameUsed = false;

  docgenResults.forEach(function(docgenResult, index) {
    if (isDefaultClassNameUsed && !docgenResult.displayName) {
      return;
    }

    let exportName = docgenResult.displayName;
    if (!exportName) {
      exportName = className;
      isDefaultClassNameUsed = true;
    }

    const docNode = buildObjectExpression(docgenResult, t);
    const docgenInfo = t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(t.identifier(exportName), t.identifier('__docgenInfo')),
        docNode
      ));
    program.pushContainer('body', docgenInfo);

    injectDocgenGlobal(exportName, path, state, t);
  });
}

function injectDocgenGlobal(className, path, state, t) {
  const program = path.scope.getProgramParent().path;

  if(!state.opts.DOC_GEN_COLLECTION_NAME) {
    return;
  }

  const globalName = state.opts.DOC_GEN_COLLECTION_NAME;
  const filePath = p.relative('./', p.resolve('./', path.hub.file.opts.filename));
  const globalNode = t.ifStatement(
    t.binaryExpression(
      '!==',
      t.unaryExpression(
        'typeof',
        t.identifier(globalName)
      ),
      t.stringLiteral('undefined')
    ),
    t.blockStatement([
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(
            t.identifier(globalName),
            t.stringLiteral(filePath),
            true
          ),
          t.objectExpression([
            t.objectProperty(
              t.identifier('name'),
              t.stringLiteral(className)
            ),
            t.objectProperty(
              t.identifier('docgenInfo'),
              t.memberExpression(
                t.identifier(className),
                t.identifier('__docgenInfo')
              )
            ),
            t.objectProperty(
              t.identifier('path'),
              t.stringLiteral(filePath)
            )
          ])
        )
      )
    ])
  );
  program.pushContainer('body', globalNode);
}

function buildObjectExpression(obj, t){
  if(_.isPlainObject(obj)) {
    const children = [];
    for (let key in obj) {
      if(!obj.hasOwnProperty(key) || _.isUndefined(obj[key])) continue;
      children.push(
        t.objectProperty(
          t.stringLiteral(key),
          buildObjectExpression(obj[key], t)
        ));
    }
    return t.objectExpression(children);
  } else if (_.isString(obj)) {
    return t.stringLiteral(obj);
  } else if (_.isBoolean(obj)) {
    return t.booleanLiteral(obj);
  } else if (_.isNumber(obj)){
    return t.numericLiteral(obj);
  } else if (_.isArray(obj)) {
    const children = [];
    obj.forEach(function (val) {
      children.push(buildObjectExpression(val, t));
    });
    return t.ArrayExpression(children);
  } else if(_.isNull(obj)) {
    return t.nullLiteral();
  }
}
