# Sourced (zsh) by scripts/package.sh and scripts/ui.sh: the llama.cpp llama-server that runs the decision model (d1-2B).
# The version is also read by scripts/paths.ts (the dev build's path).
llama_version=b12430
llama_zip=llama-$llama_version-bin-macos-arm64.tar.gz
# SHA-256 of the release asset on github.com/ggml-org/llama.cpp.
llama_sha256=7c806ac0f2257ca93590b01497f76082692d6fd5049d5f5e10cc0ad038fe765c

# fetch_llama <cache>: makes <cache>/llama-<version>/ hold llama-server, the llama.cpp dylibs it links (followed through
# @rpath, copied under their install names) and LICENSE. Downloads and checks the archive once; a no-op when already there.
fetch_llama() {
  local cache=$1
  local out=$cache/llama-$llama_version
  if [[ -x $out/llama-server ]]; then return 0; fi
  mkdir -p $cache
  if [[ ! -f $cache/$llama_zip ]]; then
    curl -fL --retry 3 -o $cache/$llama_zip.part https://github.com/ggml-org/llama.cpp/releases/download/$llama_version/$llama_zip || { print -u2 -- "could not download $llama_zip"; return 1 }
    mv $cache/$llama_zip.part $cache/$llama_zip
  fi
  print -r -- "$llama_sha256  $cache/$llama_zip" | shasum -a 256 -c - >/dev/null || { print -u2 -- "$llama_zip does not match its SHA-256, delete it from $cache and retry"; return 1 }
  local x
  x=$(mktemp -d)
  tar -xzf $cache/$llama_zip -C $x
  local src=$x/llama-$llama_version
  # The binary's rpath is @loader_path: every @rpath dependency sits next to it, under the name it is linked by.
  local -a todo seen
  local f d
  todo=(llama-server)
  while (( $#todo )); do
    f=$todo[1]
    shift todo
    if (( $seen[(Ie)$f] )); then continue; fi
    seen+=($f)
    for d in ${(f)"$(otool -L $src/$f | sed -n 's|^[[:space:]]*@rpath/\([^[:space:]]*\).*|\1|p')"}; do
      if [[ $d != $f ]]; then todo+=($d); fi
    done
  done
  rm -rf $out.part
  mkdir -p $out.part
  for f in $seen; do cp -L $src/$f $out.part/$f; done
  cp $src/LICENSE $out.part/LICENSE
  rm -rf $x
  mv $out.part $out
}
