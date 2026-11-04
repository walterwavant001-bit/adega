/* Adega do Wavant: ponte entre o site e o Firebase (Firestore + login).
 * Entrega o mesmo "window.claude.use(...)" que o site usava no Claude:
 *   use("db")     -> banco (Firestore)
 *   use("user")   -> quem está vendo (id e se é o dono)
 *   use("assets") -> envio de fotos e vídeos (só para o dono)
 * Carrega depois dos SDKs do Firebase (firebase-app, -auth e -firestore compat). */
(function () {
  "use strict";

  var CONFIG = {
    apiKey: "AIzaSyBVf9nCK92Qslqy-cgskTeqEUXRBeleKQs",
    authDomain: "adega-do-wavant.firebaseapp.com",
    projectId: "adega-do-wavant",
    storageBucket: "adega-do-wavant.firebasestorage.app",
    messagingSenderId: "240113939155",
    appId: "1:240113939155:web:254497d9a1df7d0ad59a26"
  };
  var DONO_EMAIL = "walterwavant001@gmail.com";
  var LIMITE_VIDEO = 4.4 * 1024 * 1024;  // a Vercel aceita ~4,5 MB por envio direto
  var LIMITE_FOTO = 900000;              // a foto vira texto dentro do banco (limite de 1 MB por documento)

  firebase.initializeApp(CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();

  function ehDono(u) {
    return !!(u && !u.isAnonymous && u.email === DONO_EMAIL && u.emailVerified);
  }

  // Todo visitante entra de forma anônima (o carrinho e o chat precisam de um id).
  var pronto = null;
  function entrar() {
    if (pronto) return pronto;
    pronto = new Promise(function (resolve) {
      var parar = auth.onAuthStateChanged(function (u) {
        parar();
        if (u) return resolve(u);
        auth.signInAnonymously().then(function (c) { resolve(c.user); }, function () { resolve(null); });
      });
    });
    return pronto;
  }

  // Foto -> texto JPEG reduzido, para caber no documento do banco.
  function fotoParaTexto(arquivo) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(arquivo);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var tentativas = [[1024, 0.8], [900, 0.7], [700, 0.6], [520, 0.5]];
        for (var i = 0; i < tentativas.length; i++) {
          var escala = Math.min(1, tentativas[i][0] / Math.max(img.width, img.height));
          var c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.width * escala));
          c.height = Math.max(1, Math.round(img.height * escala));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          var txt = c.toDataURL("image/jpeg", tentativas[i][1]);
          if (txt.length <= LIMITE_FOTO) return resolve(txt);
        }
        reject(new Error("A foto ficou grande demais. Use outra foto."));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Arquivo de foto inválido.")); };
      img.src = url;
    });
  }

  // Vídeo -> Vercel Blob, pelo servidor (/api/subir-video), com o login do dono.
  function enviarVideo(arquivo, nome) {
    if (arquivo.size > LIMITE_VIDEO) return Promise.reject(new Error("Vídeo maior que 4 MB. Diminua o vídeo e tente de novo."));
    var tipo = arquivo.type || "video/mp4";
    return entrar().then(function (u) {
      if (!u) throw new Error("Entre como dono para enviar.");
      return u.getIdToken();
    }).then(function (token) {
      return fetch("/api/subir-video?nome=" + encodeURIComponent(nome || arquivo.name || "video"), {
        method: "POST",
        headers: { "Content-Type": tipo, "Authorization": "Bearer " + token },
        body: arquivo
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.erro || "Não consegui enviar o vídeo.");
        return { id: j.pathname, url: j.url, sizeBytes: arquivo.size, contentType: tipo };
      });
    });
  }

  var midia = {
    upload: function (arquivo) {
      if (arquivo && /^video\//.test(arquivo.type || "")) return enviarVideo(arquivo);
      return fotoParaTexto(arquivo).then(function (txt) {
        return { id: txt, url: txt, sizeBytes: txt.length, contentType: "image/jpeg" };
      });
    },
    delete: function () { return Promise.resolve(); },
    list: function () { return Promise.resolve({ assets: [], usage: null }); }
  };

  function usuarioDe(u) {
    return {
      id: function () { return u.uid; },
      me: function () { return { id: u.uid, name: u.displayName || "" }; },
      canEdit: function () { return ehDono(u); },
      isOwner: function () { return ehDono(u); },
      can: function () { return ehDono(u); }
    };
  }

  window.claude = {
    use: function (nome) {
      return entrar().then(function (u) {
        if (!u) return null;
        if (nome === "db") return db;
        if (nome === "user") return usuarioDe(u);
        if (nome === "assets") return ehDono(u) ? midia : null;
        return null;
      });
    }
  };

  // ---- Painel do dono (só aparece com ?dono na página, ou já logado como dono) ----
  function importarCatalogo(botao, status) {
    botao.disabled = true;
    status.textContent = "Lendo o catálogo...";
    fetch("dados/catalogo.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("catalogo.json não encontrado");
      return r.json();
    }).then(function (j) {
      var itens = (j && j.itens) || [];
      var grupos = [];
      for (var i = 0; i < itens.length; i += 400) grupos.push(itens.slice(i, i + 400));
      return grupos.reduce(function (p, grupo) {
        return p.then(function () {
          var b = db.batch();
          grupo.forEach(function (it) {
            var dados = {
              ordem: Number(it.ordem),
              nome: String(it.nome || ""),
              categoria: String(it.categoria || ""),
              preco: it.preco == null ? null : Number(it.preco),
              esgotado: false
            };
            if (it.foto) dados.fotoId = String(it.foto);
            if (it.preco_status) dados.preco_status = String(it.preco_status);
            if (it.obs) dados.obs = String(it.obs);
            b.set(db.collection("itens").doc(String(it.ordem)), dados);
          });
          return b.commit();
        });
      }, Promise.resolve()).then(function () { return itens.length; });
    }).then(function (n) {
      status.textContent = n + " produtos importados. Recarregando...";
      setTimeout(function () { location.reload(); }, 800);
    }).catch(function (e) {
      botao.disabled = false;
      status.textContent = "Não consegui importar: " + (e.message || e);
    });
  }

  function botaoDo(texto, aoClicar) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = texto;
    b.setAttribute("style", "margin-top:6px;background:#14c23a;color:#021005;border:0;border-radius:6px;padding:5px 9px;font:inherit;cursor:pointer");
    b.onclick = aoClicar;
    return b;
  }

  function painel(u) {
    var box = document.createElement("div");
    box.id = "painelDono";
    box.setAttribute("style", "position:fixed;left:8px;bottom:8px;z-index:9999;max-width:250px;font:13px/1.4 system-ui,sans-serif;background:#050805;color:#b6ffc8;border:1px solid #14c23a;border-radius:8px;padding:8px 10px");
    var txt = document.createElement("div");
    var status = document.createElement("div");
    box.appendChild(txt);
    box.appendChild(status);
    document.body.appendChild(box);

    if (!ehDono(u)) {
      txt.textContent = "Área do dono";
      box.insertBefore(botaoDo("Entrar com Google", function () {
        status.textContent = "Abrindo o login do Google...";
        auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).then(function () {
          location.href = location.pathname;
        }, function (e) {
          status.textContent = "Não entrou: " + (e.code || e.message);
        });
      }), status);
      return;
    }
    txt.textContent = "Modo dono ativo.";
    box.insertBefore(botaoDo("Sair do modo dono", function () {
      auth.signOut().then(function () { location.href = location.pathname; });
    }), status);
    db.collection("itens").limit(1).get().then(function (s) {
      if (!s.empty) return;
      txt.textContent = "O catálogo ainda não está no banco.";
      box.insertBefore(botaoDo("Importar catálogo", function (ev) {
        importarCatalogo(ev.target, status);
      }), status);
    }, function () {});
  }

  function iniciarPainel() {
    entrar().then(function (u) {
      if (location.search.indexOf("dono") >= 0 || ehDono(u)) painel(u);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciarPainel);
  else iniciarPainel();
})();
