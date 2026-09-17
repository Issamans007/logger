// ja3sniffer — passive JA3 capture.
//
// It watches inbound packets on port 443, parses each TLS ClientHello, computes
// its JA3 fingerprint, and remembers it keyed by the client's ip:port. The Node
// logger — which terminates TLS itself, so it keeps the real header order —
// asks this service for the JA3 of the connection it is currently handling
// (matched by the client's ip:port, which is unique per TCP connection).
//
// This design means JA3 is captured WITHOUT a proxy in front of Node, so header
// order is preserved. The sniffer needs raw-packet access (root / CAP_NET_RAW).
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/dreadl0ck/ja3"
	"github.com/gopacket/gopacket"
	"github.com/gopacket/gopacket/pcap"
)

type entry struct {
	ja3 string
	t   time.Time
}

var (
	mu    sync.RWMutex
	store = map[string]entry{}
)

// md5("") — what the ja3 lib returns when a packet has no ClientHello.
const emptyDigest = "d41d8cd98f00b204e9800998ecf8427e"

func main() {
	iface := os.Getenv("IFACE")
	if iface == "" {
		iface = "eth0"
	}
	handle, err := pcap.OpenLive(iface, 1600, true, pcap.BlockForever)
	if err != nil {
		log.Fatalf("pcap open %s: %v", iface, err)
	}
	defer handle.Close()
	if err := handle.SetBPFFilter("tcp dst port 443"); err != nil {
		log.Fatalf("bpf filter: %v", err)
	}

	go serve()
	go cleanup()

	log.Printf("ja3sniffer up on %s (tcp dst port 443); api on 127.0.0.1:9443", iface)
	src := gopacket.NewPacketSource(handle, handle.LinkType())
	for p := range src.Packets() {
		digest := ja3.DigestHexPacket(p)
		if digest == "" || digest == emptyDigest {
			continue // not a ClientHello
		}
		netL := p.NetworkLayer()
		trL := p.TransportLayer()
		if netL == nil || trL == nil {
			continue
		}
		key := netL.NetworkFlow().Src().String() + ":" + trL.TransportFlow().Src().String()
		mu.Lock()
		store[key] = entry{ja3: digest, t: time.Now()}
		mu.Unlock()
	}
}

func serve() {
	http.HandleFunc("/ja3", func(w http.ResponseWriter, r *http.Request) {
		mu.RLock()
		e, ok := store[r.URL.Query().Get("k")]
		mu.RUnlock()
		if ok {
			fmt.Fprint(w, e.ja3)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		mu.RLock()
		n := len(store)
		mu.RUnlock()
		fmt.Fprintf(w, "ok, %d fingerprints held", n)
	})
	log.Fatal(http.ListenAndServe("127.0.0.1:9443", nil))
}

func cleanup() {
	for range time.Tick(time.Minute) {
		cut := time.Now().Add(-10 * time.Minute)
		mu.Lock()
		for k, e := range store {
			if e.t.Before(cut) {
				delete(store, k)
			}
		}
		mu.Unlock()
	}
}
