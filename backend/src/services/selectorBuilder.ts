/**
 * Selector Builder Module
 * 
 * 提供在浏览器端执行的元素选择器构建函数
 * 所有函数都以字符串形式提供，避免TypeScript编译后的__name问题
 */

/**
 * 构建最佳CSS选择器的函数（浏览器端执行版本）
 * 以字符串形式返回，用于Playwright的evaluate中动态编译
 */
export const buildBestSelectorFn = `(function(el) {
  if (el.id) return '#' + el.id;
  var testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy');
  if (testId) return '[data-testid="' + testId + '"]';  
  var ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return '[aria-label="' + ariaLabel + '"]';  
  var role = el.getAttribute('role');
  var tag = el.tagName.toLowerCase();
  var type = el.getAttribute('type');
  var name = el.getAttribute('name');
  var placeholder = el.getAttribute('placeholder');
  if (name) return tag + '[name="' + name + '"]';  
  if (placeholder) return tag + '[placeholder="' + placeholder + '"]';  
  if (type && tag === 'input') return 'input[type="' + type + '"]';  
  var classList = Array.from(el.classList).filter(function(c) { 
    return !c.startsWith('el-') || /el-(button|input|select|menu-item|dialog|form-item)/.test(c); 
  }).slice(0, 2);
  if (classList.length > 0) {
    var classSelector = tag + '.' + classList.join('.');
    if (role) return classSelector + '[role="' + role + '"]';    
    return classSelector;
  }
  if (role) return tag + '[role="' + role + '"]';  
  return tag;
})`;

/**
 * 构建Playwright Locator的函数（浏览器端执行版本）
 * 以字符串形式返回，用于Playwright的evaluate中动态编译
 */
export const buildPlaywrightLocatorFn = `(function(el) {
  var text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  var ariaLabel = el.getAttribute('aria-label');
  var role = el.getAttribute('role');
  var tag = el.tagName.toLowerCase();
  var placeholder = el.getAttribute('placeholder');
  var testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
  if (testId) return "page.getByTestId('" + testId + "')";
  if (role && text) return "page.getByRole('" + role + "', { name: '" + text.slice(0, 40) + "' })";
  if (tag === 'button' && text) return "page.getByRole('button', { name: '" + text.slice(0, 40) + "' })";
  if (tag === 'a' && text) return "page.getByRole('link', { name: '" + text.slice(0, 40) + "' })";
  if (ariaLabel) return "page.getByLabel('" + ariaLabel + "')";
  if (placeholder) return "page.getByPlaceholder('" + placeholder + "')";
  if (text && (tag === 'span' || tag === 'div' || tag === 'li')) return "page.getByText('" + text.slice(0, 40) + "')";
  
  // 动态调用buildBestSelector
  var buildSel = ${buildBestSelectorFn};
  return "page.locator('" + buildSel(el) + "')";
})`;

/**
 * 可访问性树收集脚本（浏览器端执行版本）
 * 以字符串形式返回，用于Playwright的evaluate中动态编译
 */
export const accessibilityTreeScript = `
(function() {
  var skipRoles = new Set(['generic', 'none', 'presentation']);
  var MAX_DEPTH = 4;
  var MAX_CHILDREN = 20;

  function getRole(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    var roleMap = {
      button: 'button', a: 'link', input: 'textbox', select: 'combobox',
      textarea: 'textbox', nav: 'navigation', main: 'main', header: 'banner',
      footer: 'contentinfo', form: 'form', table: 'table', dialog: 'dialog',
      img: 'img', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
      ul: 'list', ol: 'list', li: 'listitem'
    };
    if (tag === 'input') {
      var t = el.getAttribute('type');
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button') return 'button';
      return 'textbox';
    }
    return roleMap[tag] || 'generic';
  }

  function getName(el) {
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    var ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
      var ref = document.getElementById(ariaLabelledBy);
      if (ref) return (ref.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      var placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder;
      var id = el.getAttribute('id');
      if (id) {
        var label = document.querySelector('label[for="' + id + '"]');
        if (label) return (label.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      }
      return '';
    }
    if (tag === 'img') return el.getAttribute('alt') || '';
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text.slice(0, 60);
  }

  function walk(el, depth) {
    if (depth > MAX_DEPTH) return null;
    var rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;

    var role = getRole(el);
    var name = getName(el);

    var childEls = Array.from(el.children);
    var children = childEls
      .map(function(c) { return walk(c, depth + 1); })
      .filter(function(c) { return c !== null; })
      .slice(0, MAX_CHILDREN);

    if (skipRoles.has(role) && !name && children.length <= 1) {
      return children[0] || null;
    }

    if (skipRoles.has(role) && !name && children.length === 0) return null;

    var result = { role: role, name: name };
    if (children.length > 0) result.children = children;
    return result;
  }

  var root = document.querySelector('.app-main') || document.querySelector('main') || document.body;
  var result = walk(root, 0);
  return result && result.children ? result.children : (result ? [result] : []);
})()
`;

/**
 * 在浏览器端执行选择器构建函数的辅助类型
 */
export interface SelectorBuilderParams {
  maxSize?: number;
  buildSelectorSrc: string;
  buildLocatorSrc: string;
}

/**
 * 交互元素数据结构
 */
export interface InteractiveElementData {
  tag: string;
  text: string;
  selector: string;
  playwrightLocator: string;
  role?: string;
  ariaLabel?: string;
  type?: string;
  isUnique: boolean;
}

/**
 * 表单字段数据结构
 */
export interface FormFieldData {
  tag: string;
  type: string;
  selector: string;
  playwrightLocator: string;
  label?: string;
  placeholder?: string;
  name?: string;
  required: boolean;
  options?: string[];
  isUnique: boolean;
}
