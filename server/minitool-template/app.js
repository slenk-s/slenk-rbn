// 笔记发布助手：内容在打包时烧入 note.js（window.NOTE_DATA），点击图片经 Canvas 转 base64
// → writeTempFile 换成容器本地路径 → postNote 唤起发布页。ES2017 经典脚本，无模块语法。
(function () {
  'use strict';

  var data = window.NOTE_DATA || { title: '', content: '', tags: [], images: [] };
  var miniTool = window.xhs && window.xhs.miniTool;

  function el(id) { return document.getElementById(id); }

  function setStatus(msg, isError) {
    var node = el('status');
    node.textContent = msg || '';
    node.className = isError ? 'status error' : 'status';
  }

  // 渲染
  var gallery = el('gallery');
  data.images.forEach(function (src, i) {
    var img = new Image();
    img.src = src;
    img.alt = '图片 ' + (i + 1);
    gallery.appendChild(img);
  });
  el('note-title').textContent = data.title || '（无标题）';
  el('note-content').textContent = data.content || '';
  var tagsBox = el('note-tags');
  (data.tags || []).forEach(function (t) {
    var span = document.createElement('span');
    span.textContent = '#' + t;
    tagsBox.appendChild(span);
  });

  var publishing = false;

  // 包内图片 → Canvas → dataURL → writeTempFile 临时文件路径（大图不宜直接传长 base64）
  function imageToTempPath(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          var dataUrl = canvas.toDataURL('image/jpeg', 0.9);
          Promise.resolve(miniTool.writeTempFile({ data: dataUrl })).then(function (res) {
            if (res && res.filePath) resolve(res.filePath);
            else reject(new Error('writeTempFile 未返回 filePath'));
          }).catch(reject);
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('图片加载失败：' + src)); };
      img.src = src;
    });
  }

  function publish() {
    if (!miniTool || typeof miniTool.postNote !== 'function') {
      setStatus('当前环境不支持发布，请在小红书 App 内打开本小工具。', true);
      return;
    }
    if (publishing) return;
    publishing = true;
    var btn = el('publish-btn');
    btn.disabled = true;

    var paths = [];
    var index = 0;
    var total = data.images.length;

    function fail(err) {
      setStatus('失败：' + ((err && err.errMsg) || (err && err.message) || String(err)), true);
      publishing = false;
      btn.disabled = false;
    }

    function doPost() {
      setStatus('正在唤起发布页…');
      Promise.resolve(miniTool.postNote({
        title: data.title || '',
        content: data.content || '',
        pageType: 'photo_publish',
        mediaInfo: {
          image_resources: paths.map(function (p) { return { url: p }; })
        }
      })).then(function () {
        setStatus('已唤起发布页，请在发布页检查后确认发布。');
        publishing = false;
        btn.disabled = false;
      }).catch(fail);
    }

    function next() {
      if (index >= total) { doPost(); return; }
      setStatus('正在准备图片 ' + (index + 1) + '/' + total + ' …');
      imageToTempPath(data.images[index]).then(function (p) {
        paths.push(p);
        index += 1;
        next();
      }).catch(fail);
    }

    if (total === 0) { doPost(); return; }
    next();
  }

  el('publish-btn').addEventListener('click', publish);

  if (!miniTool) {
    setStatus('未检测到小红书容器环境，当前为预览模式，发布按钮不可用。', true);
  }
})();
